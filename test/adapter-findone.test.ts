import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, createTestNs, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { query } from '../src/db/pg.js'
import type pg from 'pg'

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

let adapter: DocumentAdapter
let pool: pg.Pool
let ns: string

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()
  adapter = new DocumentAdapter({ postgres: TEST_DB, ns: 'findone.test' }, [
    {
      slug: 'posts',
      prefix: 'pos',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'slug', type: 'text' },
      ],
    },
  ])
})

afterAll(async () => {
  await adapter.destroy()
  await teardownTestPool()
})

beforeEach(async () => {
  await cleanupTestData()
  ns = await createTestNs('findone.test', 'Test')
  await adapter.nsResolver.refresh()
})

describe('findOne variations', () => {
  it('findOne by id', async () => {
    const created = await adapter.create({ ns, type: 'posts', data: { title: 'By ID' } })
    const found = await adapter.findOne({ ns, type: 'posts', id: created.id })
    expect(found).not.toBeNull()
    expect(found!.title).toBe('By ID')
  })

  it('findOne by where clause', async () => {
    await adapter.create({ ns, type: 'posts', data: { title: 'By Where', slug: 'by-where' } })
    const found = await adapter.findOne({
      ns,
      type: 'posts',
      where: { slug: { equals: 'by-where' } },
    })
    expect(found).not.toBeNull()
    expect(found!.title).toBe('By Where')
  })

  it('findOne throws for invalid sqid', async () => {
    await expect(
      adapter.findOne({ ns, type: 'posts', id: 'pos_AAAAAAAAAA' }),
    ).rejects.toThrow('Invalid sqid')
  })

  it('findOne returns null when not found by where', async () => {
    const found = await adapter.findOne({
      ns,
      type: 'posts',
      where: { title: { equals: 'Does Not Exist' } },
    })
    expect(found).toBeNull()
  })

  it('findOne by where returns first match only', async () => {
    await adapter.create({ ns, type: 'posts', data: { title: 'A', status: 'published' } })
    await adapter.create({ ns, type: 'posts', data: { title: 'B', status: 'published' } })

    const found = await adapter.findOne({
      ns,
      type: 'posts',
      where: { status: { equals: 'published' } },
    })
    expect(found).not.toBeNull()
    expect(['A', 'B']).toContain(found!.title)
  })
})

describe('find with sort', () => {
  it('sorts by created ASC', async () => {
    await adapter.create({ ns, type: 'posts', data: { title: 'First' } })
    await adapter.create({ ns, type: 'posts', data: { title: 'Second' } })
    await adapter.create({ ns, type: 'posts', data: { title: 'Third' } })

    const result = await adapter.find({
      ns,
      type: 'posts',
      sort: 'created ASC',
    })

    expect(result.docs[0].title).toBe('First')
    expect(result.docs[2].title).toBe('Third')
  })

  it('sorts by created DESC (default)', async () => {
    await adapter.create({ ns, type: 'posts', data: { title: 'First' } })
    await adapter.create({ ns, type: 'posts', data: { title: 'Last' } })

    const result = await adapter.find({ ns, type: 'posts' })
    expect(result.docs[0].title).toBe('Last')
  })
})

describe('update edge cases', () => {
  it('update preserves fields not in the update payload', async () => {
    const created = await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'Original', slug: 'original', custom: 'preserved' },
    })

    const updated = await adapter.updateOne({
      ns,
      type: 'posts',
      id: created.id,
      data: { title: 'Updated' },
    })

    const doc = updated.doc as Record<string, unknown>
    expect(doc.title).toBe('Updated')
    expect(doc.slug).toBe('original')
    expect(doc.custom).toBe('preserved')
  })

  it('update can set field to null', async () => {
    const created = await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'Has Value' },
    })

    const updated = await adapter.updateOne({
      ns,
      type: 'posts',
      id: created.id,
      data: { title: null },
    })

    const doc = updated.doc as Record<string, unknown>
    expect(doc.title).toBeNull()
  })

  it('update non-existent document throws', async () => {
    const created = await adapter.create({ ns, type: 'posts', data: { title: 'Temp' } })
    await adapter.deleteMany({ ns, type: 'posts', where: { title: { equals: 'Temp' } } })

    await expect(
      adapter.updateOne({
        ns,
        type: 'posts',
        id: created.id,
        data: { title: 'X' },
      }),
    ).rejects.toThrow('Data row not found')
  })
})

describe('deleteMany edge cases', () => {
  it('deleteMany with no matches is a no-op', async () => {
    await adapter.create({ ns, type: 'posts', data: { title: 'Keep' } })

    const result = await adapter.deleteMany({
      ns,
      type: 'posts',
      where: { title: { equals: 'Does Not Exist' } },
    })

    expect(result.deleted).toBe(0)

    const posts = await adapter.find({ ns, type: 'posts' })
    expect(posts.total).toBe(1)
  })

  it('deleteMany removes multiple docs', async () => {
    await adapter.create({ ns, type: 'posts', data: { title: 'A', status: 'draft' } })
    await adapter.create({ ns, type: 'posts', data: { title: 'B', status: 'draft' } })
    await adapter.create({ ns, type: 'posts', data: { title: 'C', status: 'published' } })

    const result = await adapter.deleteMany({
      ns,
      type: 'posts',
      where: { status: { equals: 'draft' } },
    })

    expect(result.deleted).toBe(2)

    const posts = await adapter.find({ ns, type: 'posts' })
    expect(posts.total).toBe(1)
    expect(posts.docs[0].title).toBe('C')
  })
})
