import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, teardownTestPool } from './setup.js'
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
  it('resolves by exact URI', async () => {
    await query(pool, `INSERT INTO ns (uri, name, kind) VALUES ('acme.com', 'Acme', 'production')`)
    await resolver.refresh()

    const ns = resolver.resolve('acme.com')
    expect(ns).not.toBeNull()
    expect(ns!.name).toBe('Acme')
  })

  it('longest prefix match with subpath', async () => {
    await query(pool, `INSERT INTO ns (uri, name, kind) VALUES ('acme.com', 'Root', 'production')`)
    await query(pool, `INSERT INTO ns (uri, name, kind) VALUES ('acme.com/docs', 'Docs', 'production')`)
    await query(pool, `INSERT INTO ns (uri, name, kind) VALUES ('acme.com/docs/v2', 'Docs V2', 'production')`)
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

  it('getById returns correct ns', async () => {
    const result = await query<{ id: number }>(
      pool,
      `INSERT INTO ns (uri, name, kind) VALUES ('test.com', 'Test', 'production') RETURNING id`,
    )
    await resolver.refresh()

    const ns = resolver.getById(result.rows[0].id)
    expect(ns).not.toBeNull()
    expect(ns!.uri).toBe('test.com')
  })

  it('getAllByParent returns child namespaces', async () => {
    const parent = await query<{ id: number }>(
      pool,
      `INSERT INTO ns (uri, name, kind) VALUES ('parent.com', 'Parent', 'production') RETURNING id`,
    )
    await query(pool, `INSERT INTO ns (uri, name, kind, parent) VALUES ('parent.com/pr/1', 'PR1', 'preview', $1)`, [parent.rows[0].id])
    await query(pool, `INSERT INTO ns (uri, name, kind, parent) VALUES ('parent.com/pr/2', 'PR2', 'preview', $1)`, [parent.rows[0].id])
    await resolver.refresh()

    const children = resolver.getAllByParent(parent.rows[0].id)
    expect(children).toHaveLength(2)
  })

  it('resolveFromRequest extracts host and path', async () => {
    await query(pool, `INSERT INTO ns (uri, name, kind) VALUES ('app.local', 'App', 'production')`)
    await resolver.refresh()

    const ns = resolver.resolveFromRequest({
      headers: { host: 'app.local' },
      url: '/api/posts',
    })
    expect(ns).not.toBeNull()
    expect(ns!.uri).toBe('app.local')
  })
})

describe('branch lifecycle', () => {
  let parentNsId: number

  beforeEach(async () => {
    const result = await query<{ id: number }>(
      pool,
      `INSERT INTO ns (uri, name, kind, repo, branch, root)
       VALUES ('prod.com', 'Production', 'production', 'org/repo', 'main', '/')
       RETURNING id`,
    )
    parentNsId = result.rows[0].id
  })

  it('createBranch creates child namespace', async () => {
    const branch = await createBranch(pool, {
      parent: parentNsId,
      uri: 'prod.com/pr/42',
      name: 'PR #42',
      branch: 'feat/hero',
      kind: 'preview',
      ttl: '7 days',
      pr: 42,
      repo: 'org/repo',
      root: '/',
    })

    expect(branch.id).toBeGreaterThan(0)
    expect(branch.parent).toBe(parentNsId)
    expect(branch.kind).toBe('preview')
    expect(branch.pr).toBe(42)
  })

  it('mergeBranch copies changes to parent', async () => {
    const branch = await createBranch(pool, {
      parent: parentNsId,
      uri: 'prod.com/pr/99',
      branch: 'feat/merge-test',
    })

    // Insert a doc in parent
    const parentDoc = await query<{ id: number }>(
      pool,
      `INSERT INTO data (ns, collection, doc, rand) VALUES ($1, 'posts', '{"title":"Original"}', 111) RETURNING id`,
      [parentNsId],
    )

    // Fork into branch with modification
    await query(
      pool,
      `INSERT INTO data (ns, collection, doc, rand)
       VALUES ($1, 'posts', $2, 111)`,
      [branch.id, JSON.stringify({ title: 'Modified', _parent: parentDoc.rows[0].id })],
    )

    const result = await mergeBranch(pool, branch.id)
    expect(result.merged).toBe(1)

    // Parent doc should now have the modified title
    const updated = await query<{ doc: Record<string, unknown> }>(
      pool,
      `SELECT doc FROM data WHERE id = $1`,
      [parentDoc.rows[0].id],
    )
    expect(updated.rows[0].doc.title).toBe('Modified')
  })

  it('mergeBranch handles tombstones', async () => {
    const branch = await createBranch(pool, {
      parent: parentNsId,
      uri: 'prod.com/pr/100',
      branch: 'feat/delete-test',
    })

    // Insert a doc in parent
    const parentDoc = await query<{ id: number }>(
      pool,
      `INSERT INTO data (ns, collection, doc, rand) VALUES ($1, 'posts', '{"title":"Delete Me"}', 222) RETURNING id`,
      [parentNsId],
    )

    // Create tombstone in branch
    await query(
      pool,
      `INSERT INTO data (ns, collection, doc, rand) VALUES ($1, '_tombstone', $2, 0)`,
      [branch.id, JSON.stringify({ _parent: parentDoc.rows[0].id, _deleted: true })],
    )

    const result = await mergeBranch(pool, branch.id)
    expect(result.deleted).toBe(1)

    // Parent doc should be gone
    const remaining = await query(
      pool,
      `SELECT id FROM data WHERE id = $1`,
      [parentDoc.rows[0].id],
    )
    expect(remaining.rows).toHaveLength(0)
  })

  it('cleanupBranch removes all branch data', async () => {
    const branch = await createBranch(pool, {
      parent: parentNsId,
      uri: 'prod.com/pr/101',
      branch: 'feat/cleanup-test',
    })

    await query(pool,
      `INSERT INTO data (ns, collection, doc, rand) VALUES ($1, 'posts', '{"title":"Branch Doc"}', 333)`,
      [branch.id],
    )

    await cleanupBranch(pool, branch.id)

    const ns = await query(pool, `SELECT id FROM ns WHERE id = $1`, [branch.id])
    expect(ns.rows).toHaveLength(0)

    const data = await query(pool, `SELECT id FROM data WHERE ns = $1`, [branch.id])
    expect(data.rows).toHaveLength(0)
  })

  it('cleanupExpiredPreviews removes expired branches', async () => {
    // Create an expired preview (ttl in the past)
    await query(
      pool,
      `INSERT INTO ns (uri, name, kind, parent, ttl, created)
       VALUES ('prod.com/pr/expired', 'Expired', 'preview', $1, '1 second', now() - interval '1 hour')`,
      [parentNsId],
    )

    // Create a non-expired preview
    await query(
      pool,
      `INSERT INTO ns (uri, name, kind, parent, ttl)
       VALUES ('prod.com/pr/fresh', 'Fresh', 'preview', $1, '7 days')`,
      [parentNsId],
    )

    const cleaned = await cleanupExpiredPreviews(pool)
    expect(cleaned).toBe(1)

    // Fresh preview should still exist
    const remaining = await query(pool, `SELECT uri FROM ns WHERE kind = 'preview'`)
    expect(remaining.rows).toHaveLength(1)
  })
})
