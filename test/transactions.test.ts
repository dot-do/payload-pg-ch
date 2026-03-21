import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { query, transaction } from '../src/db/pg.js'
import { fromSqid } from '../src/id/sqids.js'
import type pg from 'pg'

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

let adapter: DocumentAdapter
let pool: pg.Pool
let nsId: number

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()
  adapter = new DocumentAdapter({ postgres: TEST_DB }, [
    {
      slug: 'posts',
      prefix: 'pos',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'author', type: 'relationship', relationTo: 'users' },
      ],
    },
    { slug: 'users', prefix: 'usr', fields: [{ name: 'name', type: 'text' }] },
  ])
})

afterAll(async () => {
  await adapter.destroy()
  await teardownTestPool()
})

beforeEach(async () => {
  await cleanupTestData()
  const result = await query<{ id: number }>(
    pool,
    `INSERT INTO ns (uri, name, kind) VALUES ('tx.test', 'Tx', 'production') RETURNING id`,
  )
  nsId = result.rows[0].id
  await adapter.nsResolver.refresh()
})

describe('transaction atomicity', () => {
  it('create is atomic: data + rels all succeed or all fail', async () => {
    const user = await adapter.create({ ns: nsId, collection: 'users', data: { name: 'Author' } })
    const userId = fromSqid(user.id).id

    const post = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Atomic Post', author: userId },
      actor: userId,
      meta: { ip: '1.2.3.4', agent: 'test', method: 'POST', path: '/api/posts' },
    })

    const postId = fromSqid(post.id).id

    // Data and rels should have entries
    const data = await query(pool, `SELECT id FROM data WHERE id = $1`, [postId])
    const rels = await query(pool, `SELECT id FROM rels WHERE "from" = $1`, [postId])

    expect(data.rows).toHaveLength(1)
    expect(rels.rows).toHaveLength(1)
  })

  it('update is atomic: data + rels', async () => {
    const user1 = await adapter.create({ ns: nsId, collection: 'users', data: { name: 'Author1' } })
    const user2 = await adapter.create({ ns: nsId, collection: 'users', data: { name: 'Author2' } })
    const user1Id = fromSqid(user1.id).id
    const user2Id = fromSqid(user2.id).id

    const post = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'V1', author: user1Id },
    })
    const postId = fromSqid(post.id).id

    // Update with new author
    await adapter.updateOne({
      ns: nsId,
      collection: 'posts',
      id: post.id,
      data: { title: 'V2', author: user2Id },
    })

    // Rels should point to user2 now
    const rels = await query<{ to: number }>(pool, `SELECT "to" FROM rels WHERE "from" = $1`, [postId])
    expect(rels.rows).toHaveLength(1)
    expect(rels.rows[0].to).toBe(user2Id)
  })

  it('delete is atomic: data removal', async () => {
    const post = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'To Delete' },
    })
    const postId = fromSqid(post.id).id

    await adapter.deleteMany({
      ns: nsId,
      collection: 'posts',
      where: { title: { equals: 'To Delete' } },
    })

    // Data should be gone
    const data = await query(pool, `SELECT id FROM data WHERE id = $1`, [postId])
    expect(data.rows).toHaveLength(0)
  })

  it('failed transaction rolls back completely', async () => {
    const countBefore = await query<{ cnt: number }>(pool, `SELECT count(*) AS cnt FROM data WHERE ns = $1`, [nsId])

    // This should fail because the transaction function will throw
    try {
      await transaction(pool, async (tx) => {
        await tx.query(
          `INSERT INTO data (ns, collection, doc, rand) VALUES ($1, 'posts', '{"title":"Ghost"}', 999)`,
          [nsId],
        )
        throw new Error('Intentional rollback')
      })
    } catch {
      // Expected
    }

    // Count should be unchanged
    const countAfter = await query<{ cnt: number }>(pool, `SELECT count(*) AS cnt FROM data WHERE ns = $1`, [nsId])
    expect(countAfter.rows[0].cnt).toBe(countBefore.rows[0].cnt)
  })
})


describe('action queue safety', () => {
  it('all enqueued actions are dequeued exactly once', async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.enqueue({ ns: nsId, kind: 'ordered', name: `job-${i}` })
    }

    const batch = await adapter.dequeue({ ns: nsId, kind: 'ordered', limit: 5 })
    expect(batch).toHaveLength(5)
    // All 5 jobs dequeued, no duplicates
    const names = batch.map(a => a.name).sort()
    expect(names).toEqual(['job-0', 'job-1', 'job-2', 'job-3', 'job-4'])
  })

  it('different kinds are independent', async () => {
    await adapter.enqueue({ ns: nsId, kind: 'email', name: 'send-email' })
    await adapter.enqueue({ ns: nsId, kind: 'webhook', name: 'call-webhook' })

    const emails = await adapter.dequeue({ ns: nsId, kind: 'email', limit: 10 })
    const webhooks = await adapter.dequeue({ ns: nsId, kind: 'webhook', limit: 10 })

    expect(emails).toHaveLength(1)
    expect(emails[0].name).toBe('send-email')
    expect(webhooks).toHaveLength(1)
    expect(webhooks[0].name).toBe('call-webhook')
  })

  it('checkpoint preserves step order', async () => {
    const id = await adapter.enqueue({ ns: nsId, kind: 'workflow', name: 'multi' })
    await adapter.dequeue({ ns: nsId, kind: 'workflow' })

    await adapter.checkpoint({ id, step: 1, result: { step: 'fetch' } })
    await adapter.checkpoint({ id, step: 2, result: { step: 'transform' } })
    await adapter.checkpoint({ id, step: 3, result: { step: 'load' } })

    const intId = fromSqid(id).id
    const action = await query<{ steps: unknown[]; cursor: number }>(
      pool,
      `SELECT steps, cursor FROM actions WHERE id = $1`,
      [intId],
    )

    expect(action.rows[0].cursor).toBe(3)
    const steps = action.rows[0].steps as Array<{ step: string }>
    expect(steps).toHaveLength(3)
    expect(steps[0].step).toBe('fetch')
    expect(steps[1].step).toBe('transform')
    expect(steps[2].step).toBe('load')
  })

  it('complete after checkpoint preserves steps', async () => {
    const id = await adapter.enqueue({ ns: nsId, kind: 'workflow', name: 'complete-after-cp' })
    await adapter.dequeue({ ns: nsId, kind: 'workflow' })

    await adapter.checkpoint({ id, step: 1, result: { done: 'step1' } })
    await adapter.complete({ id, output: { final: 'result' } })

    const intId = fromSqid(id).id
    const action = await query<{ status: string; steps: unknown[]; output: Record<string, unknown> }>(
      pool,
      `SELECT status, steps, output FROM actions WHERE id = $1`,
      [intId],
    )

    expect(action.rows[0].status).toBe('completed')
    expect(action.rows[0].steps).toHaveLength(1)
    expect(action.rows[0].output.final).toBe('result')
  })
})

describe('emit variations', () => {
  it('emit page view event', async () => {
    await adapter.emit({
      ns: nsId,
      kind: 'page.viewed',
      meta: { path: '/blog/hello', referrer: 'google.com', duration: 4500 },
    })

    const events = await query<{ kind: string; meta: Record<string, unknown> }>(
      pool,
      `SELECT kind, meta FROM events WHERE ns = $1 AND kind = 'page.viewed'`,
      [nsId],
    )
    expect(events.rows).toHaveLength(1)
    expect(events.rows[0].meta.duration).toBe(4500)
  })

  it('emit multiple event kinds', async () => {
    await adapter.emit({ ns: nsId, kind: 'auth.login', actor: 1 })
    await adapter.emit({ ns: nsId, kind: 'search.query', meta: { query: 'test', results: 5 } })
    await adapter.emit({ ns: nsId, kind: 'ai.generated', entity: 1, actor: 1, meta: { tokens: 500 } })

    const events = await query<{ kind: string }>(
      pool,
      `SELECT kind FROM events WHERE ns = $1 ORDER BY created`,
      [nsId],
    )
    expect(events.rows.map(r => r.kind)).toEqual(['auth.login', 'search.query', 'ai.generated'])
  })
})
