/**
 * Payload Local API integration tests
 *
 * These tests verify that the payload-pg-ch adapter works correctly through
 * Payload CMS's own Local API layer (payload.create, payload.find, etc.).
 *
 * Prerequisites:
 *   - PostgreSQL running at postgresql://postgres:test@localhost:5433/testdb
 *   - Schema already applied (test:db:up)
 *   - `payload` and `@payloadcms/richtext-lexical` installed
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getPayload, buildConfig } from 'payload'
import type { Payload } from 'payload'
import { getTestPool, setupTestSchema, teardownTestPool } from './setup.js'
import { documentDBAdapter } from '../dist/payload/database-adapter.js'
import { fromSqid } from '../src/id/sqids.js'

// ---------------------------------------------------------------------------
// Test Config
// ---------------------------------------------------------------------------

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

let payload: Payload

beforeAll(async () => {
  process.env.PAYLOAD_DISABLE_ADMIN = 'true'
  process.env.PAYLOAD_DROP_DATABASE = 'true'

  const pool = getTestPool()
  await setupTestSchema()

  // Clean all data
  await pool.query('DELETE FROM rels')
  await pool.query('DELETE FROM events')
  await pool.query('DELETE FROM actions')
  await pool.query('DELETE FROM data')

  const config = await buildConfig({
    secret: 'test-secret-at-least-32-characters-long!!',
    telemetry: false,
    db: documentDBAdapter({
      postgres: TEST_DB,
      ns: 'payload-local-api-test',
      collections: {
        posts: { prefix: 'pos' },
        users: { prefix: 'usr' },
        tags: { prefix: 'tag' },
      },
    }) as any,
    collections: [
      {
        slug: 'users',
        auth: true,
        fields: [{ name: 'name', type: 'text' }],
      },
      {
        slug: 'posts',
        admin: { useAsTitle: 'title' },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'body', type: 'textarea' },
          { name: 'status', type: 'select', options: ['draft', 'published'] },
          { name: 'author', type: 'relationship', relationTo: 'users' },
          { name: 'tags', type: 'relationship', relationTo: 'tags', hasMany: true },
        ],
      },
      {
        slug: 'tags',
        admin: { useAsTitle: 'name' },
        fields: [{ name: 'name', type: 'text', required: true }],
      },
    ],
  })

  payload = await getPayload({ config })
}, 60_000)

afterAll(async () => {
  if (payload) {
    try {
      if (typeof (payload as any).db?.destroy === 'function') {
        await (payload as any).db.destroy()
      }
    } catch { /* ignore */ }
  }
  await teardownTestPool()
})

beforeEach(async () => {
  const pool = getTestPool()
  await pool.query('DELETE FROM rels')
  await pool.query('DELETE FROM events')
  await pool.query('DELETE FROM actions')
  await pool.query('DELETE FROM data')
  // Re-create namespace doc
  await pool.query(
    `INSERT INTO data (id, ns, type, name, data, meta, rand)
     VALUES ($1, $1, 'namespaces', $1, '{}', '{"kind":"production"}', 0)`,
    ['payload-local-api-test'],
  )
})

// ---------------------------------------------------------------------------
// CRUD Lifecycle
// ---------------------------------------------------------------------------

describe('CRUD lifecycle', () => {
  it('creates a post and returns doc with id', async () => {
    const post = await payload.create({
      collection: 'posts',
      data: { title: 'Hello' },
    })

    expect(post).toBeDefined()
    expect(post.id).toBeDefined()
    expect(typeof post.id).toBe('string')
    expect(post.title).toBe('Hello')
  })

  it('finds posts and returns PaginatedDocs', async () => {
    await payload.create({ collection: 'posts', data: { title: 'Post A' } })
    await payload.create({ collection: 'posts', data: { title: 'Post B' } })

    const result = await payload.find({ collection: 'posts' })

    expect(result.docs).toHaveLength(2)
    expect(result.totalDocs).toBe(2)
    expect(result.totalPages).toBeGreaterThanOrEqual(1)
    expect(typeof result.hasNextPage).toBe('boolean')
    expect(typeof result.hasPrevPage).toBe('boolean')
    expect(result.limit).toBeGreaterThan(0)
  })

  it('finds a post by ID', async () => {
    const created = await payload.create({
      collection: 'posts',
      data: { title: 'Find Me By ID' },
    })

    const found = await payload.findByID({
      collection: 'posts',
      id: created.id,
    })

    expect(found).toBeDefined()
    expect(found.id).toBe(created.id)
    expect(found.title).toBe('Find Me By ID')
  })

  it('updates a post', async () => {
    const created = await payload.create({
      collection: 'posts',
      data: { title: 'Original Title', body: 'Original body' },
    })

    const updated = await payload.update({
      collection: 'posts',
      id: created.id,
      data: { title: 'Updated Title' },
    })

    expect(updated.id).toBe(created.id)
    expect(updated.title).toBe('Updated Title')
    // Body should be preserved (merge, not replace)
    expect(updated.body).toBe('Original body')
  })

  it('deletes a post', async () => {
    const created = await payload.create({
      collection: 'posts',
      data: { title: 'Delete Me' },
    })

    const deleted = await payload.delete({
      collection: 'posts',
      id: created.id,
    })

    expect(deleted.id).toBe(created.id)

    // Verify it's gone
    const result = await payload.find({ collection: 'posts' })
    expect(result.totalDocs).toBe(0)
  })

  it('counts posts', async () => {
    await payload.create({ collection: 'posts', data: { title: 'Count A' } })
    await payload.create({ collection: 'posts', data: { title: 'Count B' } })
    await payload.create({ collection: 'posts', data: { title: 'Count C' } })

    const result = await payload.count({ collection: 'posts' })

    expect(result.totalDocs).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

describe('relationships', () => {
  it('creates a post with author relationship and verifies population', async () => {
    const user = await payload.create({
      collection: 'users',
      data: { name: 'Author', email: 'author@test.com', password: 'test-password-123' },
    })

    const post = await payload.create({
      collection: 'posts',
      data: { title: 'Post with Author', author: user.id },
    })

    expect(post.author).toBeDefined()
    expect(post.author).toBeTruthy()
  })

  it('creates a post with hasMany tags and verifies population', async () => {
    const tag1 = await payload.create({ collection: 'tags', data: { name: 'TypeScript' } })
    const tag2 = await payload.create({ collection: 'tags', data: { name: 'Node.js' } })
    const tag3 = await payload.create({ collection: 'tags', data: { name: 'PostgreSQL' } })

    const post = await payload.create({
      collection: 'posts',
      data: {
        title: 'Tagged Post',
        tags: [tag1.id, tag2.id, tag3.id],
      },
    })

    expect(post.tags).toBeDefined()
    expect(Array.isArray(post.tags)).toBe(true)
    expect((post.tags as unknown[]).length).toBe(3)
  })

  it('updates a post to change author relationship', async () => {
    const user1 = await payload.create({
      collection: 'users',
      data: { name: 'Author 1', email: 'author1@test.com', password: 'test-password-123' },
    })
    const user2 = await payload.create({
      collection: 'users',
      data: { name: 'Author 2', email: 'author2@test.com', password: 'test-password-123' },
    })

    const post = await payload.create({
      collection: 'posts',
      data: { title: 'Changing Author', author: user1.id },
    })

    const updated = await payload.update({
      collection: 'posts',
      id: post.id,
      data: { author: user2.id },
    })

    expect(updated.author).toBeDefined()
    expect(updated.author).not.toBe(post.author)
  })
})

// ---------------------------------------------------------------------------
// Where Queries
// ---------------------------------------------------------------------------

describe('where queries', () => {
  beforeEach(async () => {
    await payload.create({ collection: 'posts', data: { title: 'Alpha Post', status: 'published' } })
    await payload.create({ collection: 'posts', data: { title: 'Beta Post', status: 'draft' } })
    await payload.create({ collection: 'posts', data: { title: 'Gamma Post', status: 'published' } })
  })

  it('filters by status with equals', async () => {
    const result = await payload.find({
      collection: 'posts',
      where: { status: { equals: 'published' } },
    })

    expect(result.totalDocs).toBe(2)
    result.docs.forEach(doc => {
      expect(doc.status).toBe('published')
    })
  })

  it('filters with contains/like', async () => {
    const result = await payload.find({
      collection: 'posts',
      where: { title: { contains: 'Alpha' } },
    })

    expect(result.totalDocs).toBe(1)
    expect(result.docs[0].title).toBe('Alpha Post')
  })

  it('filters with AND', async () => {
    const result = await payload.find({
      collection: 'posts',
      where: {
        and: [
          { status: { equals: 'published' } },
          { title: { contains: 'Gamma' } },
        ],
      },
    })

    expect(result.totalDocs).toBe(1)
    expect(result.docs[0].title).toBe('Gamma Post')
  })

  it('filters with OR', async () => {
    const result = await payload.find({
      collection: 'posts',
      where: {
        or: [
          { title: { equals: 'Alpha Post' } },
          { title: { equals: 'Gamma Post' } },
        ],
      },
    })

    expect(result.totalDocs).toBe(2)
    const titles = result.docs.map(d => d.title)
    expect(titles).toContain('Alpha Post')
    expect(titles).toContain('Gamma Post')
  })
})

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('auth', () => {
  it('creates a user with email and password', async () => {
    const user = await payload.create({
      collection: 'users',
      data: {
        email: 'newuser@test.com',
        password: 'secure-password-123',
        name: 'New User',
      },
    })

    expect(user).toBeDefined()
    expect(user.id).toBeDefined()
    expect(user.email).toBe('newuser@test.com')
    expect(user.name).toBe('New User')
    expect((user as any).password).toBeUndefined()
  })

  it('logs in with email and password', async () => {
    await payload.create({
      collection: 'users',
      data: {
        email: 'login@test.com',
        password: 'secure-password-123',
        name: 'Login User',
      },
    })

    const loginResult = await payload.login({
      collection: 'users',
      data: {
        email: 'login@test.com',
        password: 'secure-password-123',
      },
    })

    expect(loginResult).toBeDefined()
    expect(loginResult.token).toBeDefined()
    expect(typeof loginResult.token).toBe('string')
    expect(loginResult.user).toBeDefined()
    expect(loginResult.user.email).toBe('login@test.com')
  })

  it('verifies auth token works', async () => {
    await payload.create({
      collection: 'users',
      data: {
        email: 'token@test.com',
        password: 'secure-password-123',
        name: 'Token User',
      },
    })

    const loginResult = await payload.login({
      collection: 'users',
      data: {
        email: 'token@test.com',
        password: 'secure-password-123',
      },
    })

    expect(loginResult.token).toBeDefined()
    const parts = loginResult.token!.split('.')
    expect(parts).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('pagination', () => {
  it('paginates results with limit', async () => {
    for (let i = 1; i <= 15; i++) {
      await payload.create({
        collection: 'posts',
        data: { title: `Paginated Post ${String(i).padStart(2, '0')}` },
      })
    }

    const page1 = await payload.find({ collection: 'posts', limit: 5, page: 1 })
    expect(page1.docs).toHaveLength(5)
    expect(page1.totalDocs).toBe(15)
    expect(page1.totalPages).toBe(3)
    expect(page1.page).toBe(1)
    expect(page1.hasNextPage).toBe(true)
    expect(page1.hasPrevPage).toBe(false)
    expect(page1.nextPage).toBe(2)
    expect(page1.prevPage).toBeNull()

    const page2 = await payload.find({ collection: 'posts', limit: 5, page: 2 })
    expect(page2.docs).toHaveLength(5)
    expect(page2.page).toBe(2)
    expect(page2.hasNextPage).toBe(true)
    expect(page2.hasPrevPage).toBe(true)
    expect(page2.prevPage).toBe(1)
    expect(page2.nextPage).toBe(3)

    const page3 = await payload.find({ collection: 'posts', limit: 5, page: 3 })
    expect(page3.docs).toHaveLength(5)
    expect(page3.hasNextPage).toBe(false)
    expect(page3.hasPrevPage).toBe(true)
    expect(page3.nextPage).toBeNull()

    const allIds = [...page1.docs, ...page2.docs, ...page3.docs].map(d => d.id)
    const uniqueIds = new Set(allIds)
    expect(uniqueIds.size).toBe(15)
  })
})

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

describe('sort', () => {
  beforeEach(async () => {
    await payload.create({ collection: 'posts', data: { title: 'Cherry' } })
    await payload.create({ collection: 'posts', data: { title: 'Apple' } })
    await payload.create({ collection: 'posts', data: { title: 'Banana' } })
  })

  it('sorts by title ascending', async () => {
    const result = await payload.find({ collection: 'posts', sort: 'title' })
    const titles = result.docs.map(d => d.title)
    expect(titles).toEqual(['Apple', 'Banana', 'Cherry'])
  })

  it('sorts by title descending', async () => {
    const result = await payload.find({ collection: 'posts', sort: '-title' })
    const titles = result.docs.map(d => d.title)
    expect(titles).toEqual(['Cherry', 'Banana', 'Apple'])
  })
})

// ---------------------------------------------------------------------------
// ID format
// ---------------------------------------------------------------------------

describe('ID format', () => {
  it('returns sqid-format string IDs', async () => {
    const post = await payload.create({
      collection: 'posts',
      data: { title: 'ID Format Test' },
    })

    expect(typeof post.id).toBe('string')
    expect(post.id).toMatch(/^pos_/)

    const decoded = fromSqid(post.id as string)
    expect(decoded.prefix).toBe('pos')
    expect(decoded.seq).toBeGreaterThan(0)
  })

  it('users get usr_ prefix', async () => {
    const user = await payload.create({
      collection: 'users',
      data: { email: 'prefix@test.com', password: 'test-password-123', name: 'Prefix' },
    })
    expect(user.id).toMatch(/^usr_/)
  })

  it('tags get tag_ prefix', async () => {
    const tag = await payload.create({
      collection: 'tags',
      data: { name: 'Prefix Tag' },
    })
    expect(tag.id).toMatch(/^tag_/)
  })
})

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('handles empty find result', async () => {
    const result = await payload.find({ collection: 'posts' })
    expect(result.docs).toHaveLength(0)
    expect(result.totalDocs).toBe(0)
    expect(result.hasNextPage).toBe(false)
    expect(result.hasPrevPage).toBe(false)
  })

  it('handles findByID for non-existent doc', async () => {
    await expect(
      payload.findByID({ collection: 'posts', id: 'pos_nonexistent999' }),
    ).rejects.toThrow()
  })

  it('creates and retrieves a post with all fields populated', async () => {
    const post = await payload.create({
      collection: 'posts',
      data: {
        title: 'Full Post',
        body: 'This is the body content',
        status: 'draft',
      },
    })

    expect(post.title).toBe('Full Post')
    expect(post.body).toBe('This is the body content')
    expect(post.status).toBe('draft')

    const found = await payload.findByID({ collection: 'posts', id: post.id })
    expect(found.title).toBe('Full Post')
    expect(found.body).toBe('This is the body content')
    expect(found.status).toBe('draft')
  })

  it('count with where filter', async () => {
    await payload.create({ collection: 'posts', data: { title: 'Draft 1', status: 'draft' } })
    await payload.create({ collection: 'posts', data: { title: 'Draft 2', status: 'draft' } })
    await payload.create({ collection: 'posts', data: { title: 'Published 1', status: 'published' } })

    const draftCount = await payload.count({
      collection: 'posts',
      where: { status: { equals: 'draft' } },
    })
    expect(draftCount.totalDocs).toBe(2)

    const publishedCount = await payload.count({
      collection: 'posts',
      where: { status: { equals: 'published' } },
    })
    expect(publishedCount.totalDocs).toBe(1)
  })
})
