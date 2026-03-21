import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, createTestNs, teardownTestPool } from './setup.js'
import { transaction, query } from '../src/db/pg.js'
import { insertData, updateData, deleteData, findData, findOneData } from '../src/db/queries/data.js'
import { insertRel, deleteRelsForEntity, findRelsFrom, findRelsTo, extractRels } from '../src/db/queries/rels.js'
import { emit } from '../src/db/queries/events.js'
import { enqueueAction, dequeueActions, checkpointAction, completeAction, failAction, findAction } from '../src/db/queries/actions.js'
import type pg from 'pg'
import type { FieldSchema } from '../src/types.js'

let pool: pg.Pool
let ns: string

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()
})

afterAll(async () => {
  await teardownTestPool()
})

beforeEach(async () => {
  await cleanupTestData()
  ns = await createTestNs('queries.test', 'Test')
})

describe('data queries', () => {
  it('insertData returns all columns', async () => {
    const row = await transaction(pool, async (tx) => {
      return insertData(tx, {
        ns,
        type: 'posts',
        id: 'test-post-1',
        slug: 'test-post',
        data: { title: 'Test', body: 'Content' },
        status: 'draft',
        locale: 'en',
        rand: 12345,
      })
    })

    expect(row.seq).toBeGreaterThan(0)
    expect(row.ns).toBe(ns)
    expect(row.type).toBe('posts')
    expect(row.slug).toBe('test-post')
    expect(row.status).toBe('draft')
    expect(row.locale).toBe('en')
    expect(row.rand).toBe(12345)
    expect(row.created).toBeInstanceOf(Date)
    expect(row.updated).toBeInstanceOf(Date)
    const data = row.data as Record<string, unknown>
    expect(data.title).toBe('Test')
  })

  it('updateData merges and updates timestamp', async () => {
    const original = await transaction(pool, tx =>
      insertData(tx, { ns, type: 'posts', id: 'v1-post', data: { title: 'V1' }, rand: 111 }),
    )

    const updated = await transaction(pool, tx =>
      updateData(tx, {
        ns,
        seq: original.seq,
        data: { title: 'V2', extra: true },
        status: 'published',
      }),
    )

    expect(updated.seq).toBe(original.seq)
    const data = updated.data as Record<string, unknown>
    expect(data.title).toBe('V2')
    expect(updated.status).toBe('published')
    expect(updated.updated.getTime()).toBeGreaterThanOrEqual(original.updated.getTime())
  })

  it('updateData throws for missing row', async () => {
    await expect(
      transaction(pool, tx =>
        updateData(tx, { ns, seq: 999999, data: { title: 'X' } }),
      ),
    ).rejects.toThrow('Data row not found')
  })

  it('deleteData removes the row', async () => {
    const row = await transaction(pool, tx =>
      insertData(tx, { ns, type: 'posts', id: 'gone-post', data: { title: 'Gone' }, rand: 222 }),
    )

    await transaction(pool, tx => deleteData(tx, { ns, seq: row.seq }))

    const found = await findOneData(pool, { ns, seq: row.seq })
    expect(found).toBeNull()
  })

  it('findData with sort', async () => {
    await transaction(pool, async (tx) => {
      await insertData(tx, { ns, type: 'posts', id: 'sort-b', data: { title: 'B' }, rand: 1 })
      await insertData(tx, { ns, type: 'posts', id: 'sort-a', data: { title: 'A' }, rand: 2 })
      await insertData(tx, { ns, type: 'posts', id: 'sort-c', data: { title: 'C' }, rand: 3 })
    })

    const result = await findData(pool, {
      ns,
      type: 'posts',
      sort: 'created ASC',
    })

    expect(result.rows).toHaveLength(3)
    expect(result.total).toBe(3)
  })

  it('findOneData returns null for missing', async () => {
    const found = await findOneData(pool, { ns, seq: 999999 })
    expect(found).toBeNull()
  })
})

describe('rels queries', () => {
  let postSeq: number
  let userSeq: number
  let catSeq: number

  beforeEach(async () => {
    const rows = await transaction(pool, async (tx) => {
      const post = await insertData(tx, { ns, type: 'posts', id: 'rel-post', data: { title: 'Post' }, rand: 1 })
      const user = await insertData(tx, { ns, type: 'users', id: 'rel-user', data: { name: 'User' }, rand: 2 })
      const cat = await insertData(tx, { ns, type: 'categories', id: 'rel-cat', data: { title: 'Cat' }, rand: 3 })
      return { post, user, cat }
    })
    postSeq = rows.post.seq
    userSeq = rows.user.seq
    catSeq = rows.cat.seq
  })

  it('insertRel and findRelsFrom', async () => {
    await transaction(pool, async (tx) => {
      await insertRel(tx, { ns, from: postSeq, to: userSeq, path: 'author' })
      await insertRel(tx, { ns, from: postSeq, to: catSeq, path: 'categories.0', sort: 0 })
    })

    const rels = await findRelsFrom(pool, { from: postSeq })
    expect(rels).toHaveLength(2)
    expect(rels.find(r => r.path === 'author')?.to).toBe(userSeq)
  })

  it('findRelsFrom with path filter', async () => {
    await transaction(pool, async (tx) => {
      await insertRel(tx, { ns, from: postSeq, to: userSeq, path: 'author' })
      await insertRel(tx, { ns, from: postSeq, to: catSeq, path: 'categories.0' })
    })

    const rels = await findRelsFrom(pool, { from: postSeq, path: 'author' })
    expect(rels).toHaveLength(1)
    expect(rels[0].to).toBe(userSeq)
  })

  it('findRelsTo (reverse lookup)', async () => {
    await transaction(pool, async (tx) => {
      await insertRel(tx, { ns, from: postSeq, to: userSeq, path: 'author' })
    })

    const rels = await findRelsTo(pool, { to: userSeq })
    expect(rels).toHaveLength(1)
    expect(rels[0].from).toBe(postSeq)
  })

  it('deleteRelsForEntity removes all rels from entity', async () => {
    await transaction(pool, async (tx) => {
      await insertRel(tx, { ns, from: postSeq, to: userSeq, path: 'author' })
      await insertRel(tx, { ns, from: postSeq, to: catSeq, path: 'categories.0' })
      await deleteRelsForEntity(tx, { ns, from: postSeq })
    })

    const rels = await findRelsFrom(pool, { from: postSeq })
    expect(rels).toHaveLength(0)
  })

  it('upsert: insertRel with ON CONFLICT updates sort', async () => {
    await transaction(pool, async (tx) => {
      await insertRel(tx, { ns, from: postSeq, to: userSeq, path: 'author', sort: 0 })
      await insertRel(tx, { ns, from: postSeq, to: userSeq, path: 'author', sort: 5 })
    })

    const rels = await findRelsFrom(pool, { from: postSeq, path: 'author' })
    expect(rels).toHaveLength(1)
    expect(rels[0].sort).toBe(5)
  })
})

describe('extractRels', () => {
  it('extracts single relationship', () => {
    const fields: FieldSchema[] = [
      { name: 'author', type: 'relationship', relationTo: 'users' },
    ]
    const rels = extractRels({ author: 42 }, fields)
    expect(rels).toEqual([{ to: 42, path: 'author', sort: 0 }])
  })

  it('extracts hasMany relationship', () => {
    const fields: FieldSchema[] = [
      { name: 'categories', type: 'relationship', relationTo: 'categories', hasMany: true },
    ]
    const rels = extractRels({ categories: [10, 20, 30] }, fields)
    expect(rels).toHaveLength(3)
    expect(rels[0]).toEqual({ to: 10, path: 'categories.0', sort: 0 })
    expect(rels[2]).toEqual({ to: 30, path: 'categories.2', sort: 2 })
  })

  it('extracts nested array relationships', () => {
    const fields: FieldSchema[] = [
      {
        name: 'blocks',
        type: 'array',
        fields: [
          { name: 'image', type: 'upload', relationTo: 'media' },
        ],
      },
    ]
    const rels = extractRels({
      blocks: [
        { image: 100 },
        { image: 200 },
      ],
    }, fields)
    expect(rels).toHaveLength(2)
    expect(rels[0].path).toBe('blocks.0.image')
    expect(rels[1].path).toBe('blocks.1.image')
  })

  it('extracts group relationships', () => {
    const fields: FieldSchema[] = [
      {
        name: 'meta',
        type: 'group',
        fields: [
          { name: 'author', type: 'relationship', relationTo: 'users' },
        ],
      },
    ]
    const rels = extractRels({ meta: { author: 5 } }, fields)
    expect(rels).toEqual([{ to: 5, path: 'meta.author', sort: 0 }])
  })

  it('skips null/undefined values', () => {
    const fields: FieldSchema[] = [
      { name: 'author', type: 'relationship', relationTo: 'users' },
    ]
    const rels = extractRels({ author: null }, fields)
    expect(rels).toHaveLength(0)
  })

  it('handles object-form relationships { id: number }', () => {
    const fields: FieldSchema[] = [
      { name: 'author', type: 'relationship', relationTo: 'users' },
    ]
    const rels = extractRels({ author: { id: 42, name: 'User' } }, fields)
    expect(rels).toEqual([{ to: 42, path: 'author', sort: 0 }])
  })
})

describe('event queries', () => {
  it('emit writes event entry', async () => {
    const event = await emit(pool, {
      ns,
      kind: 'custom.event',
      meta: { key: 'value' },
    })

    expect(event.seq).toBeGreaterThan(0)
    expect(event.kind).toBe('custom.event')

    const events = await query<{ kind: string }>(pool, `SELECT kind FROM events WHERE ns = $1`, [ns])
    expect(events.rows).toHaveLength(1)
    expect(events.rows[0].kind).toBe('custom.event')
  })
})

describe('action queries', () => {
  it('enqueueAction stores all fields', async () => {
    const action = await transaction(pool, tx =>
      enqueueAction(tx, {
        ns,
        id: '',
        type: 'job',
        name: 'processOrder',
        input: { orderId: 123 },
        cap: 5,
        rand: 777,
      }),
    )

    expect(action.type).toBe('job')
    expect(action.name).toBe('processOrder')
    expect(action.status).toBe('pending')
    expect(action.cap).toBe(5)
    expect(action.rand).toBe(777)
    const input = action.input as Record<string, unknown>
    expect(input.orderId).toBe(123)
  })

  it('dequeueActions sets running + started', async () => {
    await transaction(pool, tx =>
      enqueueAction(tx, { ns, id: '', type: 'job', name: 'test', rand: 1 }),
    )

    const actions = await transaction(pool, tx =>
      dequeueActions(tx, { ns, type: 'job', limit: 1 }),
    )

    expect(actions).toHaveLength(1)
    expect(actions[0].status).toBe('running')
    expect(actions[0].started).not.toBeNull()
  })

  it('checkpointAction appends to steps', async () => {
    const action = await transaction(pool, tx =>
      enqueueAction(tx, { ns, id: '', type: 'workflow', name: 'multi', rand: 1 }),
    )

    await transaction(pool, tx =>
      checkpointAction(tx, { seq: action.seq, step: 1, result: { step1: 'done' } }),
    )
    await transaction(pool, tx =>
      checkpointAction(tx, { seq: action.seq, step: 2, result: { step2: 'done' } }),
    )

    const found = await findAction(pool, action.seq)
    expect(found!.cursor).toBe(2)
    const steps = found!.steps as unknown[]
    expect(steps).toHaveLength(2)
  })

  it('completeAction sets completed timestamp', async () => {
    const action = await transaction(pool, tx =>
      enqueueAction(tx, { ns, id: '', type: 'job', name: 'test', rand: 1 }),
    )

    await completeAction(pool, { seq: action.seq, output: { done: true } })

    const found = await findAction(pool, action.seq)
    expect(found!.status).toBe('completed')
    expect(found!.completed).not.toBeNull()
  })

  it('failAction auto-retries under cap', async () => {
    const action = await transaction(pool, tx =>
      enqueueAction(tx, { ns, id: '', type: 'job', name: 'test', cap: 3, rand: 1 }),
    )

    await failAction(pool, { seq: action.seq, error: { msg: 'fail' } })

    const found = await findAction(pool, action.seq)
    expect(found!.status).toBe('pending') // auto-retry
    expect(found!.retries).toBe(1)
  })

  it('failAction fails permanently at cap', async () => {
    const action = await transaction(pool, tx =>
      enqueueAction(tx, { ns, id: '', type: 'job', name: 'test', cap: 1, rand: 1 }),
    )

    await failAction(pool, { seq: action.seq, error: { msg: 'fail' } })

    const found = await findAction(pool, action.seq)
    expect(found!.status).toBe('failed')
    expect(found!.retries).toBe(1)
  })

  it('dequeue with scheduled filter', async () => {
    // Past scheduled time — should be dequeued
    await transaction(pool, tx =>
      enqueueAction(tx, {
        ns, id: '', type: 'job', name: 'past',
        scheduled: new Date(Date.now() - 60_000), rand: 1,
      }),
    )

    // Future scheduled time — should NOT be dequeued
    await transaction(pool, tx =>
      enqueueAction(tx, {
        ns, id: '', type: 'job', name: 'future',
        scheduled: new Date(Date.now() + 60_000), rand: 2,
      }),
    )

    const actions = await transaction(pool, tx =>
      dequeueActions(tx, { ns, type: 'job', limit: 10 }),
    )

    expect(actions).toHaveLength(1)
    expect(actions[0].name).toBe('past')
  })

  it('findAction returns null for missing', async () => {
    const found = await findAction(pool, 999999)
    expect(found).toBeNull()
  })
})
