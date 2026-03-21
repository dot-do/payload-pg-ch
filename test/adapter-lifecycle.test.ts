import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, createTestNs, teardownTestPool } from './setup.js'
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
    const adapter = new DocumentAdapter({ postgres: TEST_DB, ns: 'lifecycle.test' })
    await adapter.init()

    await createTestNs('lifecycle.test', 'Test')
    await adapter.nsResolver.refresh()
    const ns = adapter.nsResolver.resolve('lifecycle.test')
    expect(ns).not.toBeNull()

    await adapter.destroy()
  })

  it('multiple init/destroy cycles work', async () => {
    for (let i = 0; i < 3; i++) {
      const adapter = new DocumentAdapter({ postgres: TEST_DB, ns: 'lifecycle.test' })
      await adapter.init()
      await adapter.destroy()
    }
  })
})

describe('merge preserves relationships', () => {
  it('rels from branch are copied to parent on merge', async () => {
    const ns = await createTestNs('merge-rels.test', 'Test')

    const adapter = new DocumentAdapter({ postgres: TEST_DB, ns: 'merge-rels.test' }, [
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

    const user1 = await adapter.create({ ns, type: 'users', data: { name: 'Alice' } })
    const user2 = await adapter.create({ ns, type: 'users', data: { name: 'Bob' } })
    const user1Seq = fromSqid(user1.id).seq
    const user2Seq = fromSqid(user2.id).seq

    const post = await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'Post', author: user1Seq },
    })
    const postSeq = fromSqid(post.id).seq

    const relsBefore = await query<{ to: number }>(
      pool,
      `SELECT "to" FROM rels WHERE ns = $1 AND "from" = $2 AND path = 'author'`,
      [ns, postSeq],
    )
    expect(relsBefore.rows[0].to).toBe(user1Seq)

    const branch = await adapter.createBranch({
      parentNs: ns,
      ns: 'merge-rels.test/pr/1',
      branch: 'feat/change-author',
    })
    await adapter.nsResolver.refresh()

    await adapter.updateOne({
      ns: branch.ns,
      type: 'posts',
      id: post.id,
      data: { title: 'Post', author: user2Seq },
    })

    await adapter.mergeBranch(branch.ns)

    const relsAfter = await query<{ to: number }>(
      pool,
      `SELECT "to" FROM rels WHERE ns = $1 AND "from" = $2 AND path = 'author'`,
      [ns, postSeq],
    )
    expect(relsAfter.rows).toHaveLength(1)
    expect(relsAfter.rows[0].to).toBe(user2Seq)

    await adapter.destroy()
  })
})

describe('adapter with custom prefix config', () => {
  it('uses custom prefixes from config', async () => {
    const ns = await createTestNs('prefix.test', 'Test')

    const adapter = new DocumentAdapter(
      {
        postgres: TEST_DB,
        ns: 'prefix.test',
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
      ns,
      type: 'invoices',
      data: { total: 9999 },
    })
    expect(invoice.id).toMatch(/^inv_/)

    const receipt = await adapter.create({
      ns,
      type: 'receipts',
      data: { amount: 5000 },
    })
    expect(receipt.id).toMatch(/^rcp_/)

    await adapter.destroy()
  })
})
