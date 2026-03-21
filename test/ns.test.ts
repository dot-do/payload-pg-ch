import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, createTestNs, teardownTestPool } from './setup.js'
import { query } from '../src/db/pg.js'
import { NsResolver } from '../src/ns/resolver.js'
import { createBranch, mergeBranch, cleanupBranch, cleanupExpiredPreviews } from '../src/ns/branch.js'
import type pg from 'pg'

let pool: pg.Pool
let resolver: NsResolver

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()
  resolver = new NsResolver(pool)
})

afterAll(async () => {
  resolver.stop()
  await teardownTestPool()
})

beforeEach(async () => {
  await cleanupTestData()
})

describe('NsResolver', () => {
  it('resolves by exact ns string', async () => {
    await createTestNs('acme.com', 'Acme')
    await resolver.refresh()

    const ns = resolver.resolve('acme.com')
    expect(ns).not.toBeNull()
    expect(ns!.name).toBe('Acme')
  })

  it('longest prefix match with subpath', async () => {
    await createTestNs('acme.com', 'Root')
    await createTestNs('acme.com/docs', 'Docs')
    await createTestNs('acme.com/docs/v2', 'Docs V2')
    await resolver.refresh()

    expect(resolver.resolve('acme.com', '/')!.name).toBe('Root')
    expect(resolver.resolve('acme.com', '/docs/getting-started')!.name).toBe('Docs')
    expect(resolver.resolve('acme.com', '/docs/v2/api')!.name).toBe('Docs V2')
    expect(resolver.resolve('acme.com', '/blog')!.name).toBe('Root') // falls back to root
  })

  it('returns null for unregistered domain', async () => {
    await resolver.refresh()
    expect(resolver.resolve('unknown.com')).toBeNull()
  })

  it('getByNs returns correct ns', async () => {
    await createTestNs('test.com', 'Test')
    await resolver.refresh()

    const ns = resolver.getByNs('test.com')
    expect(ns).not.toBeNull()
    expect(ns!.ns).toBe('test.com')
  })

  it('getAllChildren returns child namespaces', async () => {
    await createTestNs('parent.com', 'Parent')
    // Create child branch namespaces with _parent in meta
    await createBranch(pool, { parentNs: 'parent.com', ns: 'parent.com/pr/1', name: 'PR1', kind: 'preview' })
    await createBranch(pool, { parentNs: 'parent.com', ns: 'parent.com/pr/2', name: 'PR2', kind: 'preview' })
    await resolver.refresh()

    const children = resolver.getAllChildren('parent.com')
    expect(children).toHaveLength(2)
  })

  it('resolveFromRequest extracts host and path', async () => {
    await createTestNs('app.local', 'App')
    await resolver.refresh()

    const ns = resolver.resolveFromRequest({
      headers: { host: 'app.local' },
      url: '/api/posts',
    })
    expect(ns).not.toBeNull()
    expect(ns!.ns).toBe('app.local')
  })
})

describe('branch lifecycle', () => {
  let parentNs: string

  beforeEach(async () => {
    parentNs = await createTestNs('prod.com', 'Production')
  })

  it('createBranch creates child namespace', async () => {
    const branch = await createBranch(pool, {
      parentNs,
      ns: 'prod.com/pr/42',
      name: 'PR #42',
      branch: 'feat/hero',
      kind: 'preview',
      ttl: '7 days',
      pr: 42,
    })

    expect(branch.seq).toBeGreaterThan(0)
    const meta = branch.meta as Record<string, unknown>
    expect(meta._parent).toBe(parentNs)
    expect(meta.kind).toBe('preview')
    expect(meta.pr).toBe(42)
  })

  it('mergeBranch copies changes to parent', async () => {
    const branch = await createBranch(pool, {
      parentNs,
      ns: 'prod.com/pr/99',
      branch: 'feat/merge-test',
    })
    await resolver.refresh()

    // Insert a doc in parent
    await query(
      pool,
      `INSERT INTO data (ns, type, id, data, rand) VALUES ($1, 'posts', 'parent-doc-1', '{"title":"Original"}', 111)`,
      [parentNs],
    )

    // Get parent doc seq
    const parentDoc = await query<{ seq: number }>(
      pool,
      `SELECT seq FROM data WHERE ns = $1 AND id = 'parent-doc-1'`,
      [parentNs],
    )

    // Fork into branch with modification
    await query(
      pool,
      `INSERT INTO data (ns, type, id, data, meta, rand)
       VALUES ($1, 'posts', 'fork-doc-1', $2, $3, 111)`,
      [branch.ns, JSON.stringify({ title: 'Modified' }), JSON.stringify({ _parent: parentDoc.rows[0].seq })],
    )

    const result = await mergeBranch(pool, branch.ns)
    expect(result.merged).toBe(1)

    // Parent doc should now have the modified title
    const updated = await query<{ data: Record<string, unknown> }>(
      pool,
      `SELECT data FROM data WHERE seq = $1`,
      [parentDoc.rows[0].seq],
    )
    expect(updated.rows[0].data.title).toBe('Modified')
  })

  it('mergeBranch handles tombstones', async () => {
    const branch = await createBranch(pool, {
      parentNs,
      ns: 'prod.com/pr/100',
      branch: 'feat/delete-test',
    })

    // Insert a doc in parent
    await query(
      pool,
      `INSERT INTO data (ns, type, id, data, rand) VALUES ($1, 'posts', 'del-doc-1', '{"title":"Delete Me"}', 222)`,
      [parentNs],
    )

    const parentDoc = await query<{ seq: number }>(
      pool,
      `SELECT seq FROM data WHERE ns = $1 AND id = 'del-doc-1'`,
      [parentNs],
    )

    // Create tombstone in branch
    await query(
      pool,
      `INSERT INTO data (ns, type, id, data, meta, rand) VALUES ($1, '_tombstone', $2, '{}', $3, 0)`,
      [branch.ns, `_tomb_${parentDoc.rows[0].seq}`, JSON.stringify({ _parent: parentDoc.rows[0].seq, _deleted: true })],
    )

    const result = await mergeBranch(pool, branch.ns)
    expect(result.deleted).toBe(1)

    // Parent doc should be gone
    const remaining = await query(
      pool,
      `SELECT seq FROM data WHERE seq = $1`,
      [parentDoc.rows[0].seq],
    )
    expect(remaining.rows).toHaveLength(0)
  })

  it('cleanupBranch removes all branch data', async () => {
    const branch = await createBranch(pool, {
      parentNs,
      ns: 'prod.com/pr/101',
      branch: 'feat/cleanup-test',
    })

    await query(pool,
      `INSERT INTO data (ns, type, id, data, rand) VALUES ($1, 'posts', 'branch-doc-1', '{"title":"Branch Doc"}', 333)`,
      [branch.ns],
    )

    await cleanupBranch(pool, branch.ns)

    const nsDoc = await query(pool, `SELECT seq FROM data WHERE ns = $1 AND type = 'namespaces'`, [branch.ns])
    expect(nsDoc.rows).toHaveLength(0)

    const data = await query(pool, `SELECT seq FROM data WHERE ns = $1`, [branch.ns])
    expect(data.rows).toHaveLength(0)
  })

  it('cleanupExpiredPreviews removes expired branches', async () => {
    // Create an expired preview (ttl in the past)
    await query(
      pool,
      `INSERT INTO data (ns, type, id, name, data, meta, rand, created)
       VALUES ('prod.com/pr/expired', 'namespaces', 'prod.com/pr/expired', 'Expired', '{}', $1, 0, now() - interval '1 hour')`,
      [JSON.stringify({ _parent: parentNs, kind: 'preview', ttl: '1 second' })],
    )

    // Create a non-expired preview
    await query(
      pool,
      `INSERT INTO data (ns, type, id, name, data, meta, rand)
       VALUES ('prod.com/pr/fresh', 'namespaces', 'prod.com/pr/fresh', 'Fresh', '{}', $1, 0)`,
      [JSON.stringify({ _parent: parentNs, kind: 'preview', ttl: '7 days' })],
    )

    const cleaned = await cleanupExpiredPreviews(pool)
    expect(cleaned).toBe(1)

    // Fresh preview should still exist
    const remaining = await query(pool, `SELECT ns FROM data WHERE type = 'namespaces' AND meta->>'kind' = 'preview'`)
    expect(remaining.rows).toHaveLength(1)
  })
})
