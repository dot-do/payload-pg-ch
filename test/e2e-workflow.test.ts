import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, createTestNs, teardownTestPool } from './setup.js'
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
    const ns = await createTestNs('acme.com', 'Acme Corp')
    await adapter.nsResolver.refresh()

    // Verify namespace resolution
    const resolved = adapter.nsResolver.resolve('acme.com', '/blog/hello')
    expect(resolved).not.toBeNull()
    expect(resolved!.ns).toBe(ns)

    // === 2. Create team members ===
    const alice = await adapter.create({
      ns,
      type: 'users',
      data: { name: 'Alice', email: 'alice@acme.com' },
    })
    const bob = await adapter.create({
      ns,
      type: 'users',
      data: { name: 'Bob', email: 'bob@acme.com' },
    })
    const aliceId = fromSqid(alice.id).seq

    // === 3. Create categories ===
    const tech = await adapter.create({ ns, type: 'categories', data: { title: 'Technology' } })
    const design = await adapter.create({ ns, type: 'categories', data: { title: 'Design' } })
    const techId = fromSqid(tech.id).seq
    const designId = fromSqid(design.id).seq

    // === 4. Create published content ===
    const post1 = await adapter.create({
      ns,
      type: 'posts',
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
      ns,
      type: 'posts',
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
    const allPosts = await adapter.find({ ns, type: 'posts' })
    expect(allPosts.total).toBe(2)

    const publishedPosts = await adapter.find({
      ns,
      type: 'posts',
      where: { status: { equals: 'published' } },
    })
    expect(publishedPosts.total).toBe(2)

    // === 5. Create preview branch (simulating a PR) ===
    const preview = await adapter.createBranch({
      parentNs: ns,
      ns: 'acme.com/pr/42',
      branch: 'feat/new-homepage',
      kind: 'preview',
      ttl: '7 days',
      pr: 42,
    })
    await adapter.nsResolver.refresh()

    // Preview inherits all content
    const previewPosts = await adapter.find({ ns: preview.ns, type: 'posts' })
    expect(previewPosts.total).toBe(2)

    // === 6. Edit content in preview ===
    await adapter.updateOne({
      ns: preview.ns,
      type: 'posts',
      id: post1.id,
      data: {
        title: 'Getting Started with Acme (Updated)',
        body: 'Completely rewritten welcome...',
      },
      actor: aliceId,
    })

    // Add a new post in preview
    const previewPost = await adapter.create({
      ns: preview.ns,
      type: 'posts',
      data: {
        title: 'New Feature Announcement',
        body: 'Exciting new features...',
        status: 'draft',
      },
    })

    // Preview now has 3 posts (2 inherited + 1 modified showing as branch override)
    const previewPostsAfterEdit = await adapter.find({ ns: preview.ns, type: 'posts' })
    expect(previewPostsAfterEdit.total).toBe(3)

    // Production unchanged
    const prodPosts = await adapter.find({ ns, type: 'posts' })
    expect(prodPosts.total).toBe(2)
    const prodPost1 = await adapter.findOne({ ns, type: 'posts', id: post1.id })
    expect(prodPost1!.title).toBe('Getting Started with Acme')

    // === 7. Merge preview to production ===
    const mergeResult = await adapter.mergeBranch(preview.ns)
    expect(mergeResult.merged).toBeGreaterThan(0)

    // Production now has the changes
    const prodPostsAfterMerge = await adapter.find({ ns, type: 'posts' })
    expect(prodPostsAfterMerge.total).toBe(3) // Original 2 + new preview post

    const mergedPost1 = await adapter.findOne({ ns, type: 'posts', id: post1.id })
    expect(mergedPost1!.title).toBe('Getting Started with Acme (Updated)')

    // === 8. Track analytics events ===
    await adapter.emit({ ns, kind: 'page.viewed', meta: { path: '/blog/getting-started' } })
    await adapter.emit({ ns, kind: 'page.viewed', meta: { path: '/blog/design-system' } })
    await adapter.emit({ ns, kind: 'search.query', meta: { query: 'design system', results: 1 } })

    // === 9. Queue background jobs ===
    const emailJob = await adapter.enqueue({
      ns,
      type: 'email',
      name: 'sendNewsletter',
      input: { template: 'weekly', recipients: ['subscribers'] },
    })

    const indexJob = await adapter.enqueue({
      ns,
      type: 'index',
      name: 'reindexSearch',
      input: { type: 'posts' },
    })

    // Process email job
    const emailBatch = await adapter.dequeue({ ns, type: 'email', limit: 1 })
    expect(emailBatch).toHaveLength(1)
    await adapter.checkpoint({ id: emailJob, step: 1, result: { sent: 150 } })
    await adapter.complete({ id: emailJob, output: { delivered: 148, bounced: 2 } })

    // Process index job
    const indexBatch = await adapter.dequeue({ ns, type: 'index', limit: 1 })
    expect(indexBatch).toHaveLength(1)
    await adapter.complete({ id: indexJob, output: { indexed: 3 } })

    // === 10. Verify emit events in events table ===
    const allEvents = await query<{ kind: string }>(
      pool,
      `SELECT kind FROM events WHERE ns = $1 ORDER BY created`,
      [ns],
    )

    const kinds = allEvents.rows.map(r => r.kind)

    // Should contain emitted non-mutation events
    expect(kinds).toContain('page.viewed')
    expect(kinds).toContain('search.query')

    // === 11. Verify relationships survived merge ===
    const post1Rels = await adapter.related({ id: post1.id, direction: 'from' })
    expect(post1Rels.length).toBeGreaterThan(0)

    // === 12. Verify unindexed data rows exist (embedding IS NULL) ===
    const unindexedRows = await query<{ collection: string }>(
      pool,
      `SELECT type FROM data WHERE ns = $1 AND embedding IS NULL`,
      [ns],
    )
    expect(unindexedRows.rows.length).toBeGreaterThan(0)
  })
})

describe('E2E: Multi-tenant isolation', () => {
  it('two tenants operate independently', async () => {
    // Create two tenants
    const ns1 = await createTestNs('tenant1.com', 'Tenant 1')
    const ns2 = await createTestNs('tenant2.com', 'Tenant 2')
    await adapter.nsResolver.refresh()

    // Each tenant creates content
    await adapter.create({ ns: ns1, type: 'posts', data: { title: 'T1 Post A' } })
    await adapter.create({ ns: ns1, type: 'posts', data: { title: 'T1 Post B' } })
    await adapter.create({ ns: ns2, type: 'posts', data: { title: 'T2 Post X' } })

    // Each tenant only sees their own
    const t1Posts = await adapter.find({ ns: ns1, type: 'posts' })
    const t2Posts = await adapter.find({ ns: ns2, type: 'posts' })

    expect(t1Posts.total).toBe(2)
    expect(t2Posts.total).toBe(1)
    expect(t1Posts.docs.every(d => (d.title as string).startsWith('T1'))).toBe(true)
    expect(t2Posts.docs.every(d => (d.title as string).startsWith('T2'))).toBe(true)

    // Emit events for each tenant
    await adapter.emit({ ns: ns1, kind: 'page.viewed' })
    await adapter.emit({ ns: ns1, kind: 'page.viewed' })
    await adapter.emit({ ns: ns2, kind: 'page.viewed' })

    const t1Events = await query(pool, `SELECT seq FROM events WHERE ns = $1`, [ns1])
    const t2Events = await query(pool, `SELECT seq FROM events WHERE ns = $1`, [ns2])

    // T1: 2 page views (mutations no longer write to events)
    expect(t1Events.rows.length).toBe(2)
    // T2: 1 page view
    expect(t2Events.rows.length).toBe(1)

    // Action queues are isolated
    await adapter.enqueue({ ns: ns1, type: 'job', name: 'tenant1-job' })
    await adapter.enqueue({ ns: ns2, type: 'job', name: 'tenant2-job' })

    const t1Jobs = await adapter.dequeue({ ns: ns1, type: 'job', limit: 10 })
    const t2Jobs = await adapter.dequeue({ ns: ns2, type: 'job', limit: 10 })

    expect(t1Jobs).toHaveLength(1)
    expect(t1Jobs[0].name).toBe('tenant1-job')
    expect(t2Jobs).toHaveLength(1)
    expect(t2Jobs[0].name).toBe('tenant2-job')
  })
})
