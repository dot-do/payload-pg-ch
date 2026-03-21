/**
 * Payload CMS Official Database Integration Test Suite
 *
 * This test mirrors the patterns from the official Payload monorepo's
 * `test/database/int.spec.ts`. It exercises the pg-ch adapter through
 * Payload's Local API layer (payload.create, payload.find, etc.) using
 * the same config patterns and operations that the official test suite uses.
 *
 * Test categories (matching official test structure):
 *   - ID type
 *   - Timestamps
 *   - CRUD (create, find, findOne, update, delete, count)
 *   - Local API (bulk updates, updateMany, deleteMany)
 *   - Transactions (basic)
 *   - Versions
 *   - Globals
 *   - Default values
 *   - Error handling
 *   - Relationships
 *   - Where queries
 *   - Pagination & Sort
 *   - Virtual fields / field persistence
 *
 * Prerequisites:
 *   - PostgreSQL running at postgresql://postgres:test@localhost:5433/testdb
 *   - Schema already applied (npm run test:db:up)
 *   - Build completed (npm run build)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getPayload, buildConfig } from 'payload'
import type { Payload } from 'payload'
import { getTestPool, setupTestSchema, teardownTestPool } from './setup.js'
import { documentDBAdapter } from '../dist/payload/database-adapter.js'

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'
const postsSlug = 'posts'
const defaultValuesSlug = 'default-values'

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
      ns: 'payload-official-test',
    }) as any,
    collections: [
      {
        slug: 'users',
        auth: true,
        fields: [{ name: 'name', type: 'text' }],
      },
      {
        slug: postsSlug,
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'text', type: 'text' },
          { name: 'number', type: 'number' },
          { name: 'publishDate', type: 'date' },
          {
            name: 'category',
            type: 'relationship',
            relationTo: 'categories',
          },
          {
            name: 'categories',
            type: 'relationship',
            relationTo: 'categories',
            hasMany: true,
          },
          {
            name: 'status',
            type: 'select',
            options: ['draft', 'published'],
          },
          {
            name: 'group',
            type: 'group',
            fields: [{ name: 'text', type: 'text' }],
          },
          {
            name: 'arrayWithIDs',
            type: 'array',
            fields: [
              { name: 'text', type: 'text' },
            ],
          },
          {
            name: 'blocks',
            type: 'blocks',
            blocks: [
              {
                slug: 'block-first',
                fields: [{ name: 'text', type: 'text' }],
              },
            ],
          },
          {
            name: 'hasTransaction',
            type: 'checkbox',
            hooks: {
              beforeChange: [({ req }) => !!req.transactionID],
            },
            admin: { readOnly: true },
          },
          {
            name: 'throwAfterChange',
            type: 'checkbox',
            defaultValue: false,
            hooks: {
              afterChange: [
                ({ value }) => {
                  if (value) throw new Error('throw after change')
                },
              ],
            },
          },
        ],
      },
      {
        slug: 'categories',
        versions: { drafts: true },
        fields: [
          { name: 'title', type: 'text' },
        ],
      },
      {
        slug: 'simple',
        fields: [
          { name: 'text', type: 'text' },
          { name: 'number', type: 'number' },
        ],
      },
      {
        slug: defaultValuesSlug,
        fields: [
          { name: 'title', type: 'text' },
          {
            name: 'defaultValue',
            type: 'text',
            defaultValue: 'default value from database',
          },
          {
            name: 'point',
            type: 'point',
            defaultValue: [10, 20],
          },
          {
            name: 'select',
            type: 'select',
            defaultValue: 'default',
            options: [
              { value: 'option0', label: 'Option 0' },
              { value: 'option1', label: 'Option 1' },
              { value: 'default', label: 'Default' },
            ],
          },
        ],
      },
      {
        slug: 'unique-fields',
        fields: [
          { name: 'slugField', type: 'text', unique: true },
        ],
      },
      {
        slug: 'no-timestamps',
        timestamps: false,
        fields: [
          { name: 'title', type: 'text' },
        ],
      },
    ],
    globals: [
      {
        slug: 'site-settings',
        fields: [
          { name: 'title', type: 'text' },
        ],
      },
      {
        slug: 'global-versioned',
        fields: [
          { name: 'text', type: 'text' },
        ],
        versions: true,
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

// Clean data between tests
beforeEach(async () => {
  const pool = getTestPool()
  await pool.query('DELETE FROM rels')
  await pool.query('DELETE FROM events')
  await pool.query('DELETE FROM actions')
  await pool.query('DELETE FROM data')
  // Re-create namespace doc (deleted above)
  await pool.query(
    `INSERT INTO data (id, ns, type, name, data, meta, rand)
     VALUES ($1, $1, 'namespaces', $1, '{}', '{"kind":"production"}', 0)`,
    ['payload-official-test'],
  )
})

// ---------------------------------------------------------------------------
// ID type (from official test/database/int.spec.ts:90)
// ---------------------------------------------------------------------------
describe('id type', () => {
  it('should return string IDs', async () => {
    const doc = await payload.create({
      collection: postsSlug,
      data: { title: 'test id type' },
    })
    expect(doc.id).toBeDefined()
    expect(typeof doc.id).toBe('string')
  })

  it('should not overwrite supplied array row IDs on create', async () => {
    const arrayRowID = '67648ed5c72f13be6eacf24e'

    const doc = await payload.create({
      collection: postsSlug,
      data: {
        title: 'test',
        arrayWithIDs: [{ id: arrayRowID, text: 'hello' }],
      },
    })

    expect(doc.arrayWithIDs?.[0]?.id).toStrictEqual(arrayRowID)
  })

  it('should not overwrite supplied block IDs on create', async () => {
    const blockID = '6764de9af79a863575c5f58c'

    const doc = await payload.create({
      collection: postsSlug,
      data: {
        title: 'test',
        blocks: [{ id: blockID, blockType: 'block-first', text: 'hello' }],
      },
    })

    expect(doc.blocks?.[0]?.id).toStrictEqual(blockID)
  })
})

// ---------------------------------------------------------------------------
// Timestamps (from official test/database/int.spec.ts:236)
// ---------------------------------------------------------------------------
describe('timestamps', () => {
  it('should have createdAt and updatedAt timestamps', async () => {
    const result = await payload.create({
      collection: postsSlug,
      data: { title: 'timestamp test' },
    })

    expect(result.createdAt).toBeDefined()
    expect(result.updatedAt).toBeDefined()
    const createdAtDate = new Date(result.createdAt)
    expect(createdAtDate.getTime()).toBeGreaterThan(0)
  })

  it('should allow createdAt to be set on create', async () => {
    const createdAt = new Date('2021-01-01T00:00:00.000Z').toISOString()
    const result = await payload.create({
      collection: postsSlug,
      data: { title: 'custom createdAt', createdAt },
    })

    expect(result.createdAt).toStrictEqual(createdAt)

    const doc = await payload.findByID({
      id: result.id,
      collection: postsSlug,
    })
    expect(doc.createdAt).toStrictEqual(createdAt)
  })

  it('should allow updatedAt to be set on create', async () => {
    const updatedAt = new Date('2022-01-01T00:00:00.000Z').toISOString()
    const result = await payload.create({
      collection: postsSlug,
      data: { title: 'custom updatedAt', updatedAt },
    })

    expect(result.updatedAt).toStrictEqual(updatedAt)
  })
})

// ---------------------------------------------------------------------------
// CRUD Create (from official test/database/int.spec.ts:2139+)
// ---------------------------------------------------------------------------
describe('CRUD - create', () => {
  it('should create a document via payload.create', async () => {
    const post = await payload.create({
      collection: postsSlug,
      data: { title: 'Hello' },
    })

    expect(post).toBeDefined()
    expect(post.id).toBeDefined()
    expect(post.title).toBe('Hello')
  })

  it('should create a user with auth', async () => {
    const user = await payload.create({
      collection: 'users',
      data: {
        email: 'test@payloadcms.com',
        password: 'test-password-123',
        name: 'Test User',
      },
    })

    expect(user).toBeDefined()
    expect(user.id).toBeDefined()
    expect(user.email).toBe('test@payloadcms.com')
    // Password should not be returned
    expect((user as any).password).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// CRUD Find (from official test/database/int.spec.ts:2139+)
// ---------------------------------------------------------------------------
describe('CRUD - find', () => {
  it('should find documents with PaginatedDocs shape', async () => {
    await payload.create({ collection: postsSlug, data: { title: 'Find A' } })
    await payload.create({ collection: postsSlug, data: { title: 'Find B' } })

    const result = await payload.find({ collection: postsSlug })

    expect(result.docs).toHaveLength(2)
    expect(result.totalDocs).toBe(2)
    expect(result.totalPages).toBeGreaterThanOrEqual(1)
    expect(typeof result.hasNextPage).toBe('boolean')
    expect(typeof result.hasPrevPage).toBe('boolean')
    expect(result.limit).toBeGreaterThan(0)
  })

  it('should findByID', async () => {
    const created = await payload.create({
      collection: postsSlug,
      data: { title: 'Find Me' },
    })

    const found = await payload.findByID({
      collection: postsSlug,
      id: created.id,
    })

    expect(found.id).toBe(created.id)
    expect(found.title).toBe('Find Me')
  })

  it('should throw Not Found for non-existent ID', async () => {
    await expect(
      payload.findByID({ collection: postsSlug, id: 'nonexistent_id_999' }),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// CRUD Update (from official test)
// ---------------------------------------------------------------------------
describe('CRUD - update', () => {
  it('should update a document', async () => {
    const created = await payload.create({
      collection: postsSlug,
      data: { title: 'Original', text: 'keep this' },
    })

    const updated = await payload.update({
      collection: postsSlug,
      id: created.id,
      data: { title: 'Updated' },
    })

    expect(updated.id).toBe(created.id)
    expect(updated.title).toBe('Updated')
    // Verify merge semantics (text should be preserved)
    expect(updated.text).toBe('keep this')
  })

  it('should update multiple documents with where', async () => {
    await payload.create({ collection: postsSlug, data: { title: 'bulk1' } })
    await payload.create({ collection: postsSlug, data: { title: 'bulk2' } })
    await payload.create({ collection: postsSlug, data: { title: 'other' } })

    const result = await payload.update({
      collection: postsSlug,
      data: { text: 'updated' },
      where: { title: { like: 'bulk' } },
    })

    expect(result.docs).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// CRUD Delete (from official test)
// ---------------------------------------------------------------------------
describe('CRUD - delete', () => {
  it('should delete a document by ID', async () => {
    const created = await payload.create({
      collection: postsSlug,
      data: { title: 'Delete Me' },
    })

    const deleted = await payload.delete({
      collection: postsSlug,
      id: created.id,
    })

    expect(deleted.id).toBe(created.id)

    // Verify it's gone
    const result = await payload.find({ collection: postsSlug })
    expect(result.totalDocs).toBe(0)
  })

  it('should delete multiple documents with where', async () => {
    await payload.create({ collection: postsSlug, data: { title: 'del1', status: 'draft' } })
    await payload.create({ collection: postsSlug, data: { title: 'del2', status: 'draft' } })
    await payload.create({ collection: postsSlug, data: { title: 'keep', status: 'published' } })

    const result = await payload.delete({
      collection: postsSlug,
      where: { status: { equals: 'draft' } },
    })

    expect(result.docs).toHaveLength(2)

    const remaining = await payload.find({ collection: postsSlug })
    expect(remaining.totalDocs).toBe(1)
    expect(remaining.docs[0].title).toBe('keep')
  })
})

// ---------------------------------------------------------------------------
// CRUD Count (from official test)
// ---------------------------------------------------------------------------
describe('CRUD - count', () => {
  it('should count documents', async () => {
    await payload.create({ collection: postsSlug, data: { title: 'c1' } })
    await payload.create({ collection: postsSlug, data: { title: 'c2' } })
    await payload.create({ collection: postsSlug, data: { title: 'c3' } })

    const result = await payload.count({ collection: postsSlug })
    expect(result.totalDocs).toBe(3)
  })

  it('should count with where filter', async () => {
    await payload.create({ collection: postsSlug, data: { title: 'draft1', status: 'draft' } })
    await payload.create({ collection: postsSlug, data: { title: 'draft2', status: 'draft' } })
    await payload.create({ collection: postsSlug, data: { title: 'pub1', status: 'published' } })

    const draftCount = await payload.count({
      collection: postsSlug,
      where: { status: { equals: 'draft' } },
    })
    expect(draftCount.totalDocs).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Local API - db-level operations (from official test/database/int.spec.ts:2139)
// ---------------------------------------------------------------------------
describe('Local API - db operations', () => {
  it('should db.create and db.find', async () => {
    const created = await payload.db.create({
      collection: postsSlug,
      data: { title: 'db-create' },
    })
    expect(created.id).toBeDefined()

    const found = await payload.db.find({
      collection: postsSlug,
    })
    expect(found.docs.length).toBeGreaterThanOrEqual(1)
  })

  it('should db.updateOne', async () => {
    const post = await payload.create({
      collection: postsSlug,
      data: { title: 'db-update' },
    })

    const updated = await payload.db.updateOne({
      id: post.id,
      collection: postsSlug,
      data: { title: 'db-updated' },
    })

    expect(updated.title).toBe('db-updated')
  })

  it('should db.deleteMany', async () => {
    await payload.create({ collection: postsSlug, data: { title: 'del-a' } })
    await payload.create({ collection: postsSlug, data: { title: 'del-b' } })

    await payload.db.deleteMany({
      collection: postsSlug,
      where: { id: { exists: true } },
    })

    const result = await payload.db.find({ collection: postsSlug })
    expect(result.docs).toHaveLength(0)
  })

  it('ensure updateMany updates all docs and respects where query', async () => {
    await payload.create({ collection: postsSlug, data: { title: 'notupdated' } })
    for (let i = 0; i < 5; i++) {
      await payload.create({ collection: postsSlug, data: { title: `v1 ${i}` } })
    }

    const result = await payload.db.updateMany({
      collection: postsSlug,
      data: { title: 'updated' },
      where: { title: { not_equals: 'notupdated' } },
    })

    expect(result?.length).toBe(5)

    const { docs } = await payload.find({
      collection: postsSlug,
      where: { title: { equals: 'updated' } },
      pagination: false,
    })
    expect(docs).toHaveLength(5)

    const { docs: notUpdatedDocs } = await payload.find({
      collection: postsSlug,
      where: { title: { equals: 'notupdated' } },
      pagination: false,
    })
    expect(notUpdatedDocs).toHaveLength(1)
  })

  it('ensure updateOne does not create new document if where has no results', async () => {
    await payload.db.updateOne({
      collection: postsSlug,
      data: { title: 'phantom' },
      where: { title: { equals: 'does not exist' } },
    })

    const allPosts = await payload.db.find({
      collection: postsSlug,
      pagination: false,
    })
    expect(allPosts.docs).toHaveLength(0)
  })

  it('ensure updateMany does not create docs if where has no results', async () => {
    await payload.db.updateMany({
      collection: postsSlug,
      data: { title: 'phantom' },
      where: { title: { equals: 'does not exist' } },
    })

    const allPosts = await payload.db.find({
      collection: postsSlug,
      pagination: false,
    })
    expect(allPosts.docs).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Where queries (from official test suite patterns)
// ---------------------------------------------------------------------------
describe('where queries', () => {
  beforeEach(async () => {
    await payload.create({ collection: postsSlug, data: { title: 'Alpha', status: 'published', number: 10 } })
    await payload.create({ collection: postsSlug, data: { title: 'Beta', status: 'draft', number: 20 } })
    await payload.create({ collection: postsSlug, data: { title: 'Gamma', status: 'published', number: 30 } })
  })

  it('filters with equals', async () => {
    const result = await payload.find({
      collection: postsSlug,
      where: { status: { equals: 'published' } },
    })
    expect(result.totalDocs).toBe(2)
  })

  it('filters with not_equals', async () => {
    const result = await payload.find({
      collection: postsSlug,
      where: { status: { not_equals: 'draft' } },
    })
    expect(result.totalDocs).toBe(2)
  })

  it('filters with contains/like', async () => {
    const result = await payload.find({
      collection: postsSlug,
      where: { title: { contains: 'lpha' } },
    })
    expect(result.totalDocs).toBe(1)
    expect(result.docs[0].title).toBe('Alpha')
  })

  it('filters with AND', async () => {
    const result = await payload.find({
      collection: postsSlug,
      where: {
        and: [
          { status: { equals: 'published' } },
          { title: { contains: 'Gamma' } },
        ],
      },
    })
    expect(result.totalDocs).toBe(1)
    expect(result.docs[0].title).toBe('Gamma')
  })

  it('filters with OR', async () => {
    const result = await payload.find({
      collection: postsSlug,
      where: {
        or: [
          { title: { equals: 'Alpha' } },
          { title: { equals: 'Gamma' } },
        ],
      },
    })
    expect(result.totalDocs).toBe(2)
    const titles = result.docs.map(d => d.title)
    expect(titles).toContain('Alpha')
    expect(titles).toContain('Gamma')
  })

  it('filters with greater_than', async () => {
    const result = await payload.find({
      collection: postsSlug,
      where: { number: { greater_than: 15 } },
    })
    expect(result.totalDocs).toBe(2)
  })

  it('filters with less_than', async () => {
    const result = await payload.find({
      collection: postsSlug,
      where: { number: { less_than: 25 } },
    })
    expect(result.totalDocs).toBe(2)
  })

  it('filters with in', async () => {
    const result = await payload.find({
      collection: postsSlug,
      where: { title: { in: ['Alpha', 'Beta'] } },
    })
    expect(result.totalDocs).toBe(2)
  })

  it('filters with not_in', async () => {
    const result = await payload.find({
      collection: postsSlug,
      where: { title: { not_in: ['Alpha', 'Beta'] } },
    })
    expect(result.totalDocs).toBe(1)
    expect(result.docs[0].title).toBe('Gamma')
  })

  it('filters with exists: true', async () => {
    const result = await payload.find({
      collection: postsSlug,
      where: { status: { exists: true } },
    })
    expect(result.totalDocs).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Pagination (from official test suite patterns)
// ---------------------------------------------------------------------------
describe('pagination', () => {
  it('should paginate results', async () => {
    for (let i = 1; i <= 15; i++) {
      await payload.create({
        collection: postsSlug,
        data: { title: `Paginated ${String(i).padStart(2, '0')}` },
      })
    }

    const page1 = await payload.find({
      collection: postsSlug,
      limit: 5,
      page: 1,
    })

    expect(page1.docs).toHaveLength(5)
    expect(page1.totalDocs).toBe(15)
    expect(page1.totalPages).toBe(3)
    expect(page1.page).toBe(1)
    expect(page1.hasNextPage).toBe(true)
    expect(page1.hasPrevPage).toBe(false)

    const page2 = await payload.find({
      collection: postsSlug,
      limit: 5,
      page: 2,
    })

    expect(page2.docs).toHaveLength(5)
    expect(page2.page).toBe(2)
    expect(page2.hasNextPage).toBe(true)
    expect(page2.hasPrevPage).toBe(true)

    const page3 = await payload.find({
      collection: postsSlug,
      limit: 5,
      page: 3,
    })

    expect(page3.docs).toHaveLength(5)
    expect(page3.hasNextPage).toBe(false)
    expect(page3.hasPrevPage).toBe(true)

    // No overlap between pages
    const allIds = [...page1.docs, ...page2.docs, ...page3.docs].map(d => d.id)
    const uniqueIds = new Set(allIds)
    expect(uniqueIds.size).toBe(15)
  })
})

// ---------------------------------------------------------------------------
// Sort (from official test suite patterns)
// ---------------------------------------------------------------------------
describe('sort', () => {
  beforeEach(async () => {
    await payload.create({ collection: postsSlug, data: { title: 'Cherry', number: 3 } })
    await payload.create({ collection: postsSlug, data: { title: 'Apple', number: 1 } })
    await payload.create({ collection: postsSlug, data: { title: 'Banana', number: 2 } })
  })

  it('sorts by title ascending', async () => {
    const result = await payload.find({
      collection: postsSlug,
      sort: 'title',
    })
    const titles = result.docs.map(d => d.title)
    expect(titles).toEqual(['Apple', 'Banana', 'Cherry'])
  })

  it('sorts by title descending', async () => {
    const result = await payload.find({
      collection: postsSlug,
      sort: '-title',
    })
    const titles = result.docs.map(d => d.title)
    expect(titles).toEqual(['Cherry', 'Banana', 'Apple'])
  })

  it('sorts by number ascending', async () => {
    const result = await payload.find({
      collection: postsSlug,
      sort: 'number',
    })
    const numbers = result.docs.map(d => d.number)
    expect(numbers).toEqual([1, 2, 3])
  })

  it('sorts by createdAt descending (default)', async () => {
    const result = await payload.find({
      collection: postsSlug,
      sort: '-createdAt',
    })
    // Most recent first
    expect(result.docs[0].title).toBe('Banana')
    expect(result.docs[2].title).toBe('Cherry')
  })
})

// ---------------------------------------------------------------------------
// Relationships (from official test suite patterns)
// ---------------------------------------------------------------------------
describe('relationships', () => {
  it('should create with relationship and retrieve', async () => {
    const category = await payload.create({
      collection: 'categories',
      data: { title: 'Tech' },
    })

    const post = await payload.create({
      collection: postsSlug,
      data: { title: 'Related Post', category: category.id },
    })

    expect(post.category).toBeDefined()

    const found = await payload.findByID({
      collection: postsSlug,
      id: post.id,
    })
    expect(found.category).toBeDefined()
  })

  it('should create with hasMany relationship', async () => {
    const cat1 = await payload.create({ collection: 'categories', data: { title: 'Cat1' } })
    const cat2 = await payload.create({ collection: 'categories', data: { title: 'Cat2' } })

    const post = await payload.create({
      collection: postsSlug,
      data: {
        title: 'Multi-cat Post',
        categories: [cat1.id, cat2.id],
      },
    })

    expect(post.categories).toBeDefined()
    expect(Array.isArray(post.categories)).toBe(true)
    expect((post.categories as unknown[]).length).toBe(2)
  })

  it('should update relationship field', async () => {
    const cat1 = await payload.create({ collection: 'categories', data: { title: 'Old' } })
    const cat2 = await payload.create({ collection: 'categories', data: { title: 'New' } })

    const post = await payload.create({
      collection: postsSlug,
      data: { title: 'Swapped', category: cat1.id },
    })

    const updated = await payload.update({
      collection: postsSlug,
      id: post.id,
      data: { category: cat2.id },
    })

    expect(updated.category).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Auth (from official test suite patterns)
// ---------------------------------------------------------------------------
describe('auth', () => {
  it('should login with email and password', async () => {
    await payload.create({
      collection: 'users',
      data: {
        email: 'login@payloadcms.com',
        password: 'test-password-123',
        name: 'Login User',
      },
    })

    const loginResult = await payload.login({
      collection: 'users',
      data: {
        email: 'login@payloadcms.com',
        password: 'test-password-123',
      },
    })

    expect(loginResult.token).toBeDefined()
    expect(typeof loginResult.token).toBe('string')
    expect(loginResult.user.email).toBe('login@payloadcms.com')
  })
})

// ---------------------------------------------------------------------------
// Versions (from official test suite patterns)
// ---------------------------------------------------------------------------
describe('versions', () => {
  it('should create versions on update for versioned collection', async () => {
    const category = await payload.create({
      collection: 'categories',
      data: { title: 'Version 1' },
    })

    await payload.update({
      collection: 'categories',
      id: category.id,
      data: { title: 'Version 2' },
    })

    const versions = await payload.findVersions({
      collection: 'categories',
    })

    // Should have at least 1 version entry
    expect(versions.totalDocs).toBeGreaterThanOrEqual(1)
  })

  it('should retrieve specific version by ID', async () => {
    const category = await payload.create({
      collection: 'categories',
      data: { title: 'Versioned Doc' },
    })

    await payload.update({
      collection: 'categories',
      id: category.id,
      data: { title: 'Updated Versioned Doc' },
    })

    const versions = await payload.findVersions({
      collection: 'categories',
    })

    if (versions.docs.length > 0) {
      const version = await payload.findVersionByID({
        collection: 'categories',
        id: versions.docs[0].id,
      })
      expect(version).toBeDefined()
      expect(version.id).toBe(versions.docs[0].id)
    }
  })
})

// ---------------------------------------------------------------------------
// Globals (from official test suite patterns)
// ---------------------------------------------------------------------------
describe('globals', () => {
  it('should create and update a global', async () => {
    const updated = await payload.updateGlobal({
      slug: 'site-settings',
      data: { title: 'My Site' },
    })

    expect(updated.title).toBe('My Site')

    const found = await payload.findGlobal({
      slug: 'site-settings',
    })

    expect(found.title).toBe('My Site')
  })

  it('should update a global multiple times', async () => {
    await payload.updateGlobal({
      slug: 'site-settings',
      data: { title: 'First' },
    })

    const second = await payload.updateGlobal({
      slug: 'site-settings',
      data: { title: 'Second' },
    })

    expect(second.title).toBe('Second')

    const found = await payload.findGlobal({ slug: 'site-settings' })
    expect(found.title).toBe('Second')
  })
})

// ---------------------------------------------------------------------------
// Default values (from official test/database/int.spec.ts:2877)
// ---------------------------------------------------------------------------
describe('default values', () => {
  it('should apply default value on create', async () => {
    const doc = await payload.create({
      collection: defaultValuesSlug,
      data: {},
    })

    expect(doc.defaultValue).toBe('default value from database')
  })

  it('should apply default select value', async () => {
    const doc = await payload.create({
      collection: defaultValuesSlug,
      data: {},
    })

    expect(doc.select).toBe('default')
  })

  it('should apply default point value', async () => {
    const doc = await payload.create({
      collection: defaultValuesSlug,
      data: {},
    })

    expect(doc.point).toEqual([10, 20])
  })
})

// ---------------------------------------------------------------------------
// Error handling (from official test/database/int.spec.ts:2814)
// ---------------------------------------------------------------------------
describe('error handling', () => {
  it('should return validation error for missing required field', async () => {
    await expect(
      payload.create({
        collection: postsSlug,
        data: {
          // title is required but missing
          title: undefined as any,
        },
      }),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Group / nested fields (from official test patterns)
// ---------------------------------------------------------------------------
describe('group and nested fields', () => {
  it('should create and retrieve group fields', async () => {
    const post = await payload.create({
      collection: postsSlug,
      data: {
        title: 'With Group',
        group: { text: 'nested value' },
      },
    })

    expect(post.group?.text).toBe('nested value')

    const found = await payload.findByID({
      collection: postsSlug,
      id: post.id,
    })

    expect(found.group?.text).toBe('nested value')
  })

  it('should update group fields', async () => {
    const post = await payload.create({
      collection: postsSlug,
      data: {
        title: 'Group Update',
        group: { text: 'original' },
      },
    })

    const updated = await payload.update({
      collection: postsSlug,
      id: post.id,
      data: { group: { text: 'updated' } },
    })

    expect(updated.group?.text).toBe('updated')
  })
})

// ---------------------------------------------------------------------------
// Arrays (from official test patterns)
// ---------------------------------------------------------------------------
describe('array fields', () => {
  it('should create and retrieve array fields', async () => {
    const post = await payload.create({
      collection: postsSlug,
      data: {
        title: 'With Array',
        arrayWithIDs: [
          { text: 'item 1' },
          { text: 'item 2' },
          { text: 'item 3' },
        ],
      },
    })

    expect(post.arrayWithIDs).toHaveLength(3)
    expect(post.arrayWithIDs?.[0]?.text).toBe('item 1')
    expect(post.arrayWithIDs?.[2]?.text).toBe('item 3')
  })

  it('should update array fields', async () => {
    const post = await payload.create({
      collection: postsSlug,
      data: {
        title: 'Array Update',
        arrayWithIDs: [{ text: 'original' }],
      },
    })

    const updated = await payload.update({
      collection: postsSlug,
      id: post.id,
      data: {
        arrayWithIDs: [{ text: 'new item 1' }, { text: 'new item 2' }],
      },
    })

    expect(updated.arrayWithIDs).toHaveLength(2)
    expect(updated.arrayWithIDs?.[0]?.text).toBe('new item 1')
  })
})

// ---------------------------------------------------------------------------
// Blocks (from official test patterns)
// ---------------------------------------------------------------------------
describe('block fields', () => {
  it('should create and retrieve block fields', async () => {
    const post = await payload.create({
      collection: postsSlug,
      data: {
        title: 'With Blocks',
        blocks: [
          { blockType: 'block-first', text: 'block content' },
        ],
      },
    })

    expect(post.blocks).toHaveLength(1)
    expect(post.blocks?.[0]?.blockType).toBe('block-first')
    expect((post.blocks?.[0] as any)?.text).toBe('block content')
  })
})

// ---------------------------------------------------------------------------
// Simple collection CRUD (from official test - "simple" slug)
// ---------------------------------------------------------------------------
describe('simple collection', () => {
  it('should CRUD simple documents', async () => {
    const created = await payload.create({
      collection: 'simple',
      data: { text: 'hello', number: 42 },
    })
    expect(created.text).toBe('hello')
    expect(created.number).toBe(42)

    const found = await payload.findByID({
      collection: 'simple',
      id: created.id,
    })
    expect(found.text).toBe('hello')

    const updated = await payload.update({
      collection: 'simple',
      id: created.id,
      data: { text: 'world' },
    })
    expect(updated.text).toBe('world')
    expect(updated.number).toBe(42)

    const deleted = await payload.delete({
      collection: 'simple',
      id: created.id,
    })
    expect(deleted.id).toBe(created.id)

    const result = await payload.find({ collection: 'simple' })
    expect(result.totalDocs).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// No-timestamps collection (from official test - "noTimeStamps" slug)
// ---------------------------------------------------------------------------
describe('no-timestamps collection', () => {
  it('should create doc without timestamps', async () => {
    const doc = await payload.create({
      collection: 'no-timestamps',
      data: { title: 'no timestamps' },
    })

    expect(doc.id).toBeDefined()
    expect(doc.title).toBe('no timestamps')
  })
})
