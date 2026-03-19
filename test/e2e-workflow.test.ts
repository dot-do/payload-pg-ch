import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { fromSqid } from '../src/id/sqids.js'
import { query } from '../src/db/pg.js'
import type pg from 'pg'

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

let adapter: DocumentAdapter
let pool: pg.Pool

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()
  adapter = new DocumentAdapter({ postgres: TEST_DB }, [
    {
      slug: 'posts',
      prefix: 'pos',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'body', type: 'textarea' },
        { name: 'author', type: 'relationship', relationTo: 'users' },
        { name: 'categories', type: 'relationship', relationTo: 'categories', hasMany: true },
      ],
    },
    {
      slug: 'users',
      prefix: 'usr',
      fields: [
        { name: 'name', type: 'text' },
        { name: 'email', type: 'email' },
      ],
    },
    {
      slug: 'categories',
      prefix: 'cat',
      fields: [{ name: 'title', type: 'text' }],
    },
  ])
})

afterAll(async () => {
  await adapter.destroy()
  await teardownTestPool()
})

beforeEach(async () => {
  await cleanupTestData()
})

describe('E2E: Full content management workflow', () => {
  it('tenant onboarding → content creation → preview → merge → publish', async () => {
    // === 1. Tenant onboarding: create production namespace ===
    const nsResult = await query<{ id: number }>(
      pool,
      `INSERT INTO ns (uri, name, kind, repo, branch, root, plan)
       VALUES ('acme.com', 'Acme Corp', 'production', 'acme/site', 'main', '/content', 'pro')
       RETURNING id`,
    )
    const nsId = nsResult.rows[0].id
    await adapter.nsResolver.refresh()

    // Verify namespace resolution
    const resolved = adapter.nsResolver.resolve('acme.com', '/blog/hello')
    expect(resolved).not.toBeNull()
    expect(resolved!.id).toBe(nsId)

    // === 2. Create team members ===
    const alice = await adapter.create({
      ns: nsId,
      collection: 'users',
      data: { name: 'Alice', email: 'alice@acme.com' },
    })
    const bob = await adapter.create({
      ns: nsId,
      collection: 'users',
      data: { name: 'Bob', email: 'bob@acme.com' },
    })
    const aliceId = fromSqid(alice.id).id

    // === 3. Create categories ===
    const tech = await adapter.create({ ns: nsId, collection: 'categories', data: { title: 'Technology' } })
    const design = await adapter.create({ ns: nsId, collection: 'categories', data: { title: 'Design' } })
    const techId = fromSqid(tech.id).id
    const designId = fromSqid(design.id).id

    // === 4. Create published content ===
    const post1 = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: {
        title: 'Getting Started with Acme',
        body: 'Welcome to Acme...',
        author: aliceId,
        categories: [techId],
        status: 'published',
      },
      actor: aliceId,
      meta: { ip: '10.0.0.1', agent: 'Chrome', method: 'POST', path: '/api/posts' },
    })

    const post2 = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: {
        title: 'Design System Overview',
        body: 'Our design system...',
        author: aliceId,
        categories: [designId, techId],
        status: 'published',
      },
      actor: aliceId,
    })

    // Verify content
    const allPosts = await adapter.find({ ns: nsId, collection: 'posts' })
    expect(allPosts.total).toBe(2)

    const publishedPosts = await adapter.find({
      ns: nsId,
      collection: 'posts',
      where: { status: { equals: 'published' } },
    })
    expect(publishedPosts.total).toBe(2)

    // === 5. Create preview branch (simulating a PR) ===
    const preview = await adapter.createBranch({
      parent: nsId,
      uri: 'acme.com/pr/42',
      branch: 'feat/new-homepage',
      kind: 'preview',
      ttl: '7 days',
      pr: 42,
    })
    await adapter.nsResolver.refresh()

    // Preview inherits all content
    const previewPosts = await adapter.find({ ns: preview.id, collection: 'posts' })
    expect(previewPosts.total).toBe(2)

    // === 6. Edit content in preview ===
    await adapter.updateOne({
      ns: preview.id,
      collection: 'posts',
      id: post1.id,
      data: {
        title: 'Getting Started with Acme (Updated)',
        body: 'Completely rewritten welcome...',
      },
      actor: aliceId,
    })

    // Add a new post in preview
    const previewPost = await adapter.create({
      ns: preview.id,
      collection: 'posts',
      data: {
        title: 'New Feature Announcement',
        body: 'Exciting new features...',
        status: 'draft',
      },
    })

    // Preview now has 3 posts (2 inherited + 1 modified showing as branch override)
    const previewPostsAfterEdit = await adapter.find({ ns: preview.id, collection: 'posts' })
    expect(previewPostsAfterEdit.total).toBe(3)

    // Production unchanged
    const prodPosts = await adapter.find({ ns: nsId, collection: 'posts' })
    expect(prodPosts.total).toBe(2)
    const prodPost1 = await adapter.findOne({ ns: nsId, collection: 'posts', id: post1.id })
    expect(prodPost1!.title).toBe('Getting Started with Acme')

    // === 7. Merge preview to production ===
    const mergeResult = await adapter.mergeBranch(preview.id)
    expect(mergeResult.merged).toBeGreaterThan(0)

    // Production now has the changes
    const prodPostsAfterMerge = await adapter.find({ ns: nsId, collection: 'posts' })
    expect(prodPostsAfterMerge.total).toBe(3) // Original 2 + new preview post

    const mergedPost1 = await adapter.findOne({ ns: nsId, collection: 'posts', id: post1.id })
    expect(mergedPost1!.title).toBe('Getting Started with Acme (Updated)')

    // === 8. Track analytics events ===
    await adapter.emit({ ns: nsId, kind: 'page.viewed', meta: { path: '/blog/getting-started' } })
    await adapter.emit({ ns: nsId, kind: 'page.viewed', meta: { path: '/blog/design-system' } })
    await adapter.emit({ ns: nsId, kind: 'search.query', meta: { query: 'design system', results: 1 } })

    // === 9. Queue background jobs ===
    const emailJob = await adapter.enqueue({
      ns: nsId,
      kind: 'email',
      name: 'sendNewsletter',
      input: { template: 'weekly', recipients: ['subscribers'] },
    })

    const indexJob = await adapter.enqueue({
      ns: nsId,
      kind: 'index',
      name: 'reindexSearch',
      input: { collection: 'posts' },
    })

    // Process email job
    const emailBatch = await adapter.dequeue({ ns: nsId, kind: 'email', limit: 1 })
    expect(emailBatch).toHaveLength(1)
    await adapter.checkpoint({ id: emailJob, step: 1, result: { sent: 150 } })
    await adapter.complete({ id: emailJob, output: { delivered: 148, bounced: 2 } })

    // Process index job
    const indexBatch = await adapter.dequeue({ ns: nsId, kind: 'index', limit: 1 })
    expect(indexBatch).toHaveLength(1)
    await adapter.complete({ id: indexJob, output: { indexed: 3 } })

    // === 10. Verify full audit trail ===
    const allLogs = await query<{ kind: string }>(
      pool,
      `SELECT kind FROM log WHERE ns = $1 ORDER BY created`,
      [nsId],
    )

    const kinds = allLogs.rows.map(r => r.kind)

    // Should contain all lifecycle events including merge operations
    expect(kinds).toContain('data.created')
    expect(kinds).toContain('data.updated') // from merge
    expect(kinds).toContain('page.viewed')
    expect(kinds).toContain('search.query')

    // Count create events (users + categories + posts)
    const createEvents = kinds.filter(k => k === 'data.created')
    expect(createEvents.length).toBeGreaterThanOrEqual(4) // 2 users + 2 categories + posts

    // === 11. Verify relationships survived merge ===
    const post1Rels = await adapter.related({ id: post1.id, direction: 'from' })
    expect(post1Rels.length).toBeGreaterThan(0)

    // === 12. Verify pending rows for search indexing ===
    const pendingRows = await query<{ collection: string }>(
      pool,
      `SELECT collection FROM pending WHERE ns = $1`,
      [nsId],
    )
    expect(pendingRows.rows.length).toBeGreaterThan(0)
  })
})

describe('E2E: Multi-tenant isolation', () => {
  it('two tenants operate independently', async () => {
    // Create two tenants
    const tenant1 = await query<{ id: number }>(
      pool,
      `INSERT INTO ns (uri, name, kind) VALUES ('tenant1.com', 'Tenant 1', 'production') RETURNING id`,
    )
    const tenant2 = await query<{ id: number }>(
      pool,
      `INSERT INTO ns (uri, name, kind) VALUES ('tenant2.com', 'Tenant 2', 'production') RETURNING id`,
    )
    const ns1 = tenant1.rows[0].id
    const ns2 = tenant2.rows[0].id
    await adapter.nsResolver.refresh()

    // Each tenant creates content
    await adapter.create({ ns: ns1, collection: 'posts', data: { title: 'T1 Post A' } })
    await adapter.create({ ns: ns1, collection: 'posts', data: { title: 'T1 Post B' } })
    await adapter.create({ ns: ns2, collection: 'posts', data: { title: 'T2 Post X' } })

    // Each tenant only sees their own
    const t1Posts = await adapter.find({ ns: ns1, collection: 'posts' })
    const t2Posts = await adapter.find({ ns: ns2, collection: 'posts' })

    expect(t1Posts.total).toBe(2)
    expect(t2Posts.total).toBe(1)
    expect(t1Posts.docs.every(d => (d.title as string).startsWith('T1'))).toBe(true)
    expect(t2Posts.docs.every(d => (d.title as string).startsWith('T2'))).toBe(true)

    // Emit events for each tenant
    await adapter.emit({ ns: ns1, kind: 'page.viewed' })
    await adapter.emit({ ns: ns1, kind: 'page.viewed' })
    await adapter.emit({ ns: ns2, kind: 'page.viewed' })

    const t1Logs = await query(pool, `SELECT id FROM log WHERE ns = $1`, [ns1])
    const t2Logs = await query(pool, `SELECT id FROM log WHERE ns = $1`, [ns2])

    // T1: 2 creates + 2 page views = 4
    expect(t1Logs.rows.length).toBe(4)
    // T2: 1 create + 1 page view = 2
    expect(t2Logs.rows.length).toBe(2)

    // Action queues are isolated
    await adapter.enqueue({ ns: ns1, kind: 'job', name: 'tenant1-job' })
    await adapter.enqueue({ ns: ns2, kind: 'job', name: 'tenant2-job' })

    const t1Jobs = await adapter.dequeue({ ns: ns1, kind: 'job', limit: 10 })
    const t2Jobs = await adapter.dequeue({ ns: ns2, kind: 'job', limit: 10 })

    expect(t1Jobs).toHaveLength(1)
    expect(t1Jobs[0].name).toBe('tenant1-job')
    expect(t2Jobs).toHaveLength(1)
    expect(t2Jobs[0].name).toBe('tenant2-job')
  })
})
