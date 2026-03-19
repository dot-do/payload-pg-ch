import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { fromSqid } from '../src/id/sqids.js'
import { query } from '../src/db/pg.js'
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
        { name: 'tags', type: 'relationship', relationTo: 'tags', hasMany: true },
      ],
    },
    { slug: 'users', prefix: 'usr', fields: [{ name: 'name', type: 'text' }] },
    { slug: 'tags', prefix: 'tag', fields: [{ name: 'label', type: 'text' }] },
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
    `INSERT INTO ns (uri, name, kind) VALUES ('relsqid.test', 'Test', 'production') RETURNING id`,
  )
  nsId = result.rows[0].id
  await adapter.nsResolver.refresh()
})

describe('relationship sqids are correct and stable', () => {
  it('related doc sqids match their actual sqids from create', async () => {
    const user = await adapter.create({ ns: nsId, collection: 'users', data: { name: 'Alice' } })
    const userId = fromSqid(user.id).id

    const tag1 = await adapter.create({ ns: nsId, collection: 'tags', data: { label: 'Tech' } })
    const tag2 = await adapter.create({ ns: nsId, collection: 'tags', data: { label: 'AI' } })
    const tag1Id = fromSqid(tag1.id).id
    const tag2Id = fromSqid(tag2.id).id

    const post = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Post', author: userId, tags: [tag1Id, tag2Id] },
    })

    // Find the post — the author and tags fields should have correct sqids
    const found = await adapter.findOne({ ns: nsId, collection: 'posts', id: post.id })

    // Author sqid should match the user's actual sqid
    expect(found!.author).toBe(user.id)

    // Tag sqids should match the actual sqids
    const foundTags = found!.tags as string[]
    expect(foundTags).toHaveLength(2)
    expect(foundTags).toContain(tag1.id)
    expect(foundTags).toContain(tag2.id)
  })

  it('related sqids have correct prefixes', async () => {
    const user = await adapter.create({ ns: nsId, collection: 'users', data: { name: 'Bob' } })
    const userId = fromSqid(user.id).id

    const post = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Post', author: userId },
    })

    const found = await adapter.findOne({ ns: nsId, collection: 'posts', id: post.id })
    const authorSqid = found!.author as string

    // Should have usr_ prefix since author is a user
    expect(authorSqid).toMatch(/^usr_/)

    // Decoding should give the correct user id
    const decoded = fromSqid(authorSqid)
    expect(decoded.prefix).toBe('usr')
    expect(decoded.id).toBe(userId)
  })

  it('related sqids are stable across find calls', async () => {
    const user = await adapter.create({ ns: nsId, collection: 'users', data: { name: 'Charlie' } })
    const userId = fromSqid(user.id).id

    const post = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Stable Rels', author: userId },
    })

    const found1 = await adapter.findOne({ ns: nsId, collection: 'posts', id: post.id })
    const found2 = await adapter.findOne({ ns: nsId, collection: 'posts', id: post.id })

    expect(found1!.author).toBe(found2!.author)
  })

  it('related sqids in find() match findOne()', async () => {
    const user = await adapter.create({ ns: nsId, collection: 'users', data: { name: 'Diana' } })
    const userId = fromSqid(user.id).id

    const post = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Consistent', author: userId },
    })

    const findResult = await adapter.find({ ns: nsId, collection: 'posts' })
    const findOneResult = await adapter.findOne({ ns: nsId, collection: 'posts', id: post.id })

    expect(findResult.docs[0].author).toBe(findOneResult!.author)
  })
})
