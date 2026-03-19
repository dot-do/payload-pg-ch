import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { fromSqid } from '../src/id/sqids.js'
import { query } from '../src/db/pg.js'
import type pg from 'pg'

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

let pool: pg.Pool

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()
})

afterAll(async () => {
  await teardownTestPool()
})

beforeEach(async () => {
  await cleanupTestData()
})

describe('adapter init/destroy lifecycle', () => {
  it('init starts ns resolver, destroy stops it', async () => {
    const adapter = new DocumentAdapter({ postgres: TEST_DB })
    await adapter.init()

    // Should be able to resolve after init
    await query(pool, `INSERT INTO ns (uri, name, kind) VALUES ('lifecycle.test', 'Test', 'production')`)
    await adapter.nsResolver.refresh()
    const ns = adapter.nsResolver.resolve('lifecycle.test')
    expect(ns).not.toBeNull()

    await adapter.destroy()
  })

  it('multiple init/destroy cycles work', async () => {
    for (let i = 0; i < 3; i++) {
      const adapter = new DocumentAdapter({ postgres: TEST_DB })
      await adapter.init()
      await adapter.destroy()
    }
  })
})

describe('merge creates pending rows for search reindexing', () => {
  it('merged updated docs get pending rows in parent', async () => {
    const nsResult = await query<{ id: number }>(
      pool,
      `INSERT INTO ns (uri, name, kind) VALUES ('merge-pending.test', 'Test', 'production') RETURNING id`,
    )
    const nsId = nsResult.rows[0].id

    const adapter = new DocumentAdapter({ postgres: TEST_DB }, [
      { slug: 'posts', prefix: 'pos', fields: [{ name: 'title', type: 'text' }] },
    ])
    await adapter.nsResolver.refresh()

    // Create content in parent
    const post = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Original Title', body: 'Original body' },
    })

    // Clear pending from the create
    await query(pool, `DELETE FROM pending WHERE ns = $1`, [nsId])

    // Create branch, modify, merge
    const branch = await adapter.createBranch({
      parent: nsId,
      uri: 'merge-pending.test/pr/1',
      branch: 'feat/update',
    })
    await adapter.nsResolver.refresh()

    await adapter.updateOne({
      ns: branch.id,
      collection: 'posts',
      id: post.id,
      data: { title: 'Updated Title' },
    })

    await adapter.mergeBranch(branch.id)

    // Parent should have a pending row for the merged doc
    const pending = await query<{ entity: number; collection: string; title: string }>(
      pool,
      `SELECT entity, collection, title FROM pending WHERE ns = $1`,
      [nsId],
    )
    expect(pending.rows).toHaveLength(1)
    expect(pending.rows[0].collection).toBe('posts')
    expect(pending.rows[0].title).toBe('Updated Title')

    await adapter.destroy()
  })

  it('merged new docs get pending rows in parent', async () => {
    const nsResult = await query<{ id: number }>(
      pool,
      `INSERT INTO ns (uri, name, kind) VALUES ('merge-new-pending.test', 'Test', 'production') RETURNING id`,
    )
    const nsId = nsResult.rows[0].id

    const adapter = new DocumentAdapter({ postgres: TEST_DB }, [
      { slug: 'posts', prefix: 'pos', fields: [{ name: 'title', type: 'text' }] },
    ])
    await adapter.nsResolver.refresh()

    // Create branch with new content
    const branch = await adapter.createBranch({
      parent: nsId,
      uri: 'merge-new-pending.test/pr/2',
      branch: 'feat/new',
    })
    await adapter.nsResolver.refresh()

    await adapter.create({
      ns: branch.id,
      collection: 'posts',
      data: { title: 'Brand New Post' },
    })

    await adapter.mergeBranch(branch.id)

    // Parent should have pending for the new doc
    const pending = await query<{ title: string }>(
      pool,
      `SELECT title FROM pending WHERE ns = $1`,
      [nsId],
    )
    expect(pending.rows).toHaveLength(1)
    expect(pending.rows[0].title).toBe('Brand New Post')

    await adapter.destroy()
  })
})

describe('merge preserves relationships', () => {
  it('rels from branch are copied to parent on merge', async () => {
    const nsResult = await query<{ id: number }>(
      pool,
      `INSERT INTO ns (uri, name, kind) VALUES ('merge-rels.test', 'Test', 'production') RETURNING id`,
    )
    const nsId = nsResult.rows[0].id

    const adapter = new DocumentAdapter({ postgres: TEST_DB }, [
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
    await adapter.nsResolver.refresh()

    // Create user and post in parent
    const user1 = await adapter.create({ ns: nsId, collection: 'users', data: { name: 'Alice' } })
    const user2 = await adapter.create({ ns: nsId, collection: 'users', data: { name: 'Bob' } })
    const user1Id = fromSqid(user1.id).id
    const user2Id = fromSqid(user2.id).id

    const post = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Post', author: user1Id },
    })
    const postId = fromSqid(post.id).id

    // Verify initial rel
    const relsBefore = await query<{ to: number }>(
      pool,
      `SELECT "to" FROM rels WHERE ns = $1 AND "from" = $2 AND path = 'author'`,
      [nsId, postId],
    )
    expect(relsBefore.rows[0].to).toBe(user1Id)

    // Create branch, change author to Bob
    const branch = await adapter.createBranch({
      parent: nsId,
      uri: 'merge-rels.test/pr/1',
      branch: 'feat/change-author',
    })
    await adapter.nsResolver.refresh()

    await adapter.updateOne({
      ns: branch.id,
      collection: 'posts',
      id: post.id,
      data: { title: 'Post', author: user2Id },
    })

    // Merge
    await adapter.mergeBranch(branch.id)

    // Parent rels should now point to user2
    const relsAfter = await query<{ to: number }>(
      pool,
      `SELECT "to" FROM rels WHERE ns = $1 AND "from" = $2 AND path = 'author'`,
      [nsId, postId],
    )
    expect(relsAfter.rows).toHaveLength(1)
    expect(relsAfter.rows[0].to).toBe(user2Id)

    await adapter.destroy()
  })
})

describe('adapter with custom prefix config', () => {
  it('uses custom prefixes from config', async () => {
    const nsResult = await query<{ id: number }>(
      pool,
      `INSERT INTO ns (uri, name, kind) VALUES ('prefix.test', 'Test', 'production') RETURNING id`,
    )
    const nsId = nsResult.rows[0].id

    const adapter = new DocumentAdapter(
      {
        postgres: TEST_DB,
        collections: {
          invoices: { prefix: 'inv' },
          receipts: { prefix: 'rcp' },
        },
      },
      [
        { slug: 'invoices', fields: [{ name: 'total', type: 'number' }] },
        { slug: 'receipts', fields: [{ name: 'amount', type: 'number' }] },
      ],
    )
    await adapter.nsResolver.refresh()

    const invoice = await adapter.create({
      ns: nsId,
      collection: 'invoices',
      data: { total: 9999 },
    })
    expect(invoice.id).toMatch(/^inv_/)

    const receipt = await adapter.create({
      ns: nsId,
      collection: 'receipts',
      data: { amount: 5000 },
    })
    expect(receipt.id).toMatch(/^rcp_/)

    await adapter.destroy()
  })
})
