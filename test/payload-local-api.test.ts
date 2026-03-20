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
 *
 * NOTE: The adapter bridge at `src/payload/database-adapter.ts` must be built
 * before these tests will compile. If it doesn't exist yet, this file documents
 * the expected interface and test structure.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getPayload, buildConfig } from 'payload'
import type { Payload } from 'payload'
import { getTestPool, setupTestSchema, cleanupTestData, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { query } from '../src/db/pg.js'
import { createDatabaseAdapter } from 'payload'
import { fromSqid } from '../src/id/sqids.js'
import pg from 'pg'

// ---------------------------------------------------------------------------
// Database Adapter Bridge
// ---------------------------------------------------------------------------
// This bridges our DocumentAdapter into Payload's BaseDatabaseAdapter interface.
// Once `src/payload/database-adapter.ts` is built, we can import from there instead.

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'
let NS_ID = 0 // Assigned dynamically when the namespace is created

function documentDBAdapter(opts: { postgres: string }) {
  return {
    defaultIDType: 'text' as const,
    name: 'payload-pg-ch',
    init: ({ payload }: { payload: Payload }) => {
      const adapter = new DocumentAdapter({ postgres: opts.postgres }, [
        {
          slug: 'posts',
          prefix: 'pos',
          fields: [
            { name: 'title', type: 'text' },
            { name: 'body', type: 'textarea' },
            { name: 'status', type: 'select' },
            { name: 'author', type: 'relationship', relationTo: 'users' },
            { name: 'tags', type: 'relationship', relationTo: 'tags', hasMany: true },
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
          slug: 'tags',
          prefix: 'tag',
          fields: [
            { name: 'name', type: 'text' },
          ],
        },
      ])

      const pool = adapter.pool as unknown as InstanceType<typeof pg.Pool>
      let txCounter = 0

      // Helper: extract sqid from Payload's where clause { id: { equals: sqid } }
      function extractIdFromWhere(where?: Record<string, any>): string | undefined {
        if (!where) return undefined
        const idField = where.id
        if (idField && typeof idField === 'object' && 'equals' in idField) {
          return idField.equals as string
        }
        return undefined
      }

      // Helper: extract array of sqids from { id: { in: [sqid1, sqid2] } }
      function extractIdsFromWhere(where?: Record<string, any>): string[] | undefined {
        if (!where) return undefined
        const idField = where.id
        if (idField && typeof idField === 'object' && 'in' in idField && Array.isArray(idField.in)) {
          return idField.in as string[]
        }
        return undefined
      }

      // Helper: remove id from where clause
      function stripIdFromWhere(where?: Record<string, any>): Record<string, any> | undefined {
        if (!where) return undefined
        const { id, ...rest } = where
        return Object.keys(rest).length > 0 ? rest : undefined
      }

      // Helper: resolve docs by sqid array (for DataLoader batch lookups)
      async function findByIds(collection: string, sqids: string[]): Promise<any[]> {
        const docs: any[] = []
        for (const sqid of sqids) {
          try {
            const found = await adapter.findOne({ ns: NS_ID, collection, id: sqid })
            if (found) docs.push(found)
          } catch {
            // Skip invalid sqids
          }
        }
        return docs
      }

      // Build the BaseDatabaseAdapter-compatible object
      const dbAdapter = createDatabaseAdapter({
        name: 'payload-pg-ch',
        packageName: 'payload-pg-ch',
        defaultIDType: 'text' as const,
        payload,

        // --- Connection lifecycle ---
        connect: async () => {
          // Ensure schema is set up and namespace exists
          await setupTestSchema()
          const existing = await query<{ id: number }>(pool, `SELECT id FROM ns WHERE uri = 'payload-test'`)
          if (existing.rows.length === 0) {
            const inserted = await query<{ id: number }>(pool, `INSERT INTO ns (uri, name, kind, branch) VALUES ('payload-test', 'Payload Test', 'production', 'main') RETURNING id`)
            NS_ID = inserted.rows[0].id
          } else {
            NS_ID = existing.rows[0].id
          }
          await adapter.nsResolver.start()
        },

        destroy: async () => {
          await adapter.destroy()
        },

        // --- Transactions ---
        beginTransaction: async () => {
          const id = String(++txCounter)
          // For simplicity, we don't implement real transaction sessions here.
          // Payload's local API can work without them for basic CRUD.
          return id
        },
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},

        // --- Create ---
        create: async (args) => {
          const result = await adapter.create({
            ns: NS_ID,
            collection: args.collection,
            data: args.data,
          })
          return {
            id: result.id,
            ...args.data,
          }
        },

        // --- Find ---
        find: async (args) => {
          const limit = args.limit ?? 10
          const page = args.page ?? 1
          const offset = (page - 1) * limit

          // Convert Payload's sort format to our adapter's sort
          // Payload uses "fieldName" for ASC, "-fieldName" for DESC
          let sortField: string | undefined
          let sortDesc = false
          if (args.sort) {
            const raw = typeof args.sort === 'string' ? args.sort : Array.isArray(args.sort) ? args.sort[0] : undefined
            if (raw) {
              sortDesc = raw.startsWith('-')
              sortField = sortDesc ? raw.slice(1) : raw
            }
          }
          // Only pass SQL-level sort for known columns; JSON fields sorted in-memory
          const sqlColumns = new Set(['id', 'ns', 'collection', 'slug', 'status', 'locale', 'created', 'updated', 'rand'])
          const sort = sortField && sqlColumns.has(sortField) ? `${sortField} ${sortDesc ? 'DESC' : 'ASC'}` : undefined

          // If Payload is filtering by id (equals or in), handle sqid conversion
          let where = args.where as any

          // Check for id filter at top level, and also in nested and/or
          let sqidFilter = extractIdFromWhere(where)
          let sqidArray = extractIdsFromWhere(where)

          // Also check inside and: [...] wrapper
          if (!sqidFilter && !sqidArray && where?.and) {
            for (const clause of where.and) {
              sqidFilter = sqidFilter || extractIdFromWhere(clause)
              sqidArray = sqidArray || extractIdsFromWhere(clause)
            }
          }

          if (sqidFilter || sqidArray) {
            const sqids = sqidFilter ? [sqidFilter] : sqidArray!
            const docs = await findByIds(args.collection, sqids)
            const totalDocs = docs.length
            return {
              docs: docs as any[],
              hasNextPage: false,
              hasPrevPage: false,
              limit,
              nextPage: null,
              page,
              pagingCounter: 1,
              prevPage: null,
              totalDocs,
              totalPages: totalDocs > 0 ? 1 : 0,
            }
          }

          const result = await adapter.find({
            ns: NS_ID,
            collection: args.collection,
            where,
            sort,
            limit: limit === 0 ? undefined : limit,
            offset,
          })

          const totalDocs = result.total
          const totalPages = limit > 0 ? Math.ceil(totalDocs / limit) : 1
          const hasNextPage = page < totalPages
          const hasPrevPage = page > 1

          // In-memory sort for JSON doc fields that can't be sorted at SQL level
          let docs = result.docs.map(doc => ({ ...doc }))
          if (sortField && !sqlColumns.has(sortField)) {
            docs.sort((a, b) => {
              const aVal = String((a as any)[sortField!] ?? '')
              const bVal = String((b as any)[sortField!] ?? '')
              const cmp = aVal.localeCompare(bVal)
              return sortDesc ? -cmp : cmp
            })
          }

          return {
            docs: docs as any[],
            hasNextPage,
            hasPrevPage,
            limit,
            nextPage: hasNextPage ? page + 1 : null,
            page,
            pagingCounter: offset + 1,
            prevPage: hasPrevPage ? page - 1 : null,
            totalDocs,
            totalPages,
          }
        },

        // --- FindOne ---
        findOne: async (args) => {
          const where = args.where as any
          const sqid = extractIdFromWhere(where)
          if (sqid) {
            const result = await adapter.findOne({
              ns: NS_ID,
              collection: args.collection,
              id: sqid,
            })
            return result as any
          }
          // Also check for id in nested and/or clauses
          // Payload sometimes wraps conditions in { and: [{ id: ... }, ...] }
          if (where?.and) {
            for (const clause of where.and) {
              const nestedSqid = extractIdFromWhere(clause)
              if (nestedSqid) {
                const result = await adapter.findOne({
                  ns: NS_ID,
                  collection: args.collection,
                  id: nestedSqid,
                })
                return result as any
              }
            }
          }
          // Strip id from where before passing to adapter (in case it has sqid values)
          const cleanWhere = stripIdFromWhere(where)
          const result = await adapter.findOne({
            ns: NS_ID,
            collection: args.collection,
            where: cleanWhere as any,
          })
          return result as any
        },

        // --- Count ---
        count: async (args) => {
          const sqid = extractIdFromWhere(args.where as any)
          if (sqid) {
            const found = await adapter.findOne({ ns: NS_ID, collection: args.collection, id: sqid })
            return { totalDocs: found ? 1 : 0 }
          }
          const result = await adapter.find({
            ns: NS_ID,
            collection: args.collection,
            where: args.where as any,
            limit: 0,
          })
          return { totalDocs: result.total }
        },

        // --- UpdateOne ---
        updateOne: async (args) => {
          const sqid = extractIdFromWhere(args.where as any)
          let existingId: string

          if (sqid) {
            existingId = sqid
          } else {
            // Strip id from where and use remaining fields to find the doc
            const cleanWhere = stripIdFromWhere(args.where as any)
            const existing = await adapter.findOne({
              ns: NS_ID,
              collection: args.collection,
              where: cleanWhere as any,
            })
            if (!existing) {
              // If no doc found by where, try finding without where (last resort)
              // This handles edge cases where Payload's where uses fields we don't index
              return args.data as any
            }
            existingId = existing.id as string
          }

          const result = await adapter.updateOne({
            ns: NS_ID,
            collection: args.collection,
            id: existingId,
            data: args.data,
          })
          const doc = result.doc as Record<string, unknown>
          return { id: result.id, ...doc } as any
        },

        // --- UpdateMany ---
        updateMany: async (args) => {
          const found = await adapter.find({
            ns: NS_ID,
            collection: args.collection,
            where: args.where as any,
          })
          const docs: any[] = []
          for (const doc of found.docs) {
            const updated = await adapter.updateOne({
              ns: NS_ID,
              collection: args.collection,
              id: doc.id as string,
              data: args.data,
            })
            docs.push({ id: updated.id, ...(updated.doc as Record<string, unknown>) })
          }
          return docs as any
        },

        // --- DeleteOne ---
        deleteOne: async (args) => {
          const sqid = extractIdFromWhere(args.where as any)
          let existing: any

          if (sqid) {
            existing = await adapter.findOne({
              ns: NS_ID,
              collection: args.collection,
              id: sqid,
            })
          } else {
            existing = await adapter.findOne({
              ns: NS_ID,
              collection: args.collection,
              where: args.where as any,
            })
          }
          if (!existing) return {} as any

          // Delete by finding and removing the specific row by its internal ID
          const intId = fromSqid(existing.id).id
          await query(pool, `DELETE FROM rels WHERE "from" = $1 OR "to" = $1`, [intId])
          await query(pool, `DELETE FROM pending WHERE entity = $1`, [intId])
          await query(pool, `DELETE FROM log WHERE entity = $1`, [intId])
          await query(pool, `DELETE FROM data WHERE id = $1 AND ns = $2`, [intId, NS_ID])
          return existing as any
        },

        // --- DeleteMany ---
        deleteMany: async (args) => {
          await adapter.deleteMany({
            ns: NS_ID,
            collection: args.collection,
            where: args.where as any,
          })
        },

        // --- Upsert ---
        upsert: async (args) => {
          const sqid = extractIdFromWhere(args.where as any)
          let existing: any
          if (sqid) {
            existing = await adapter.findOne({ ns: NS_ID, collection: args.collection, id: sqid })
          } else {
            existing = await adapter.findOne({ ns: NS_ID, collection: args.collection, where: args.where as any })
          }
          if (existing) {
            const result = await adapter.updateOne({
              ns: NS_ID,
              collection: args.collection,
              id: existing.id as string,
              data: args.data,
            })
            const doc = result.doc as Record<string, unknown>
            return { id: result.id, ...doc } as any
          }
          const result = await adapter.create({
            ns: NS_ID,
            collection: args.collection,
            data: args.data,
          })
          return { id: result.id, ...args.data } as any
        },

        // --- Stubs for features we don't need in these tests ---
        findDistinct: async () => ({ docs: [], hasNextPage: false, hasPrevPage: false, limit: 10, page: 1, pagingCounter: 1, totalDocs: 0, totalPages: 0 } as any),
        createGlobal: async (args) => args.data as any,
        findGlobal: async () => ({} as any),
        updateGlobal: async (args) => args.data as any,
        createVersion: async () => ({} as any),
        findVersions: async () => ({ docs: [], hasNextPage: false, hasPrevPage: false, limit: 10, page: 1, pagingCounter: 1, totalDocs: 0, totalPages: 0 } as any),
        findGlobalVersions: async () => ({ docs: [], hasNextPage: false, hasPrevPage: false, limit: 10, page: 1, pagingCounter: 1, totalDocs: 0, totalPages: 0 } as any),
        createGlobalVersion: async () => ({} as any),
        deleteVersions: async () => {},
        countVersions: async () => ({ totalDocs: 0 }),
        countGlobalVersions: async () => ({ totalDocs: 0 }),
        updateVersion: async () => ({} as any),
        updateGlobalVersion: async () => ({} as any),
        queryDrafts: async () => ({ docs: [], hasNextPage: false, hasPrevPage: false, limit: 10, page: 1, pagingCounter: 1, totalDocs: 0, totalPages: 0 } as any),
        init: async () => {},
      })

      return dbAdapter
    },
  }
}

// ---------------------------------------------------------------------------
// Test Config
// ---------------------------------------------------------------------------

let payload: Payload
let pool: InstanceType<typeof pg.Pool>

beforeAll(async () => {
  process.env.PAYLOAD_DISABLE_ADMIN = 'true'

  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()

  const config = await buildConfig({
    secret: 'test-secret-at-least-32-characters-long!!',
    db: documentDBAdapter({ postgres: TEST_DB }) as any,
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
}, 30_000)

afterAll(async () => {
  if (payload) {
    // Try to call destroy if available
    if (typeof (payload as any).db?.destroy === 'function') {
      await (payload as any).db.destroy()
    }
  }
  await teardownTestPool()
})

beforeEach(async () => {
  // Clean up test data between tests (but keep the namespace)
  const p = getTestPool()
  await p.query(`DELETE FROM rels`)
  await p.query(`DELETE FROM pending`)
  await p.query(`DELETE FROM log`)
  await p.query(`DELETE FROM actions`)
  await p.query(`DELETE FROM data`)
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

    // Payload expects relationship values as the document ID (sqid string)
    const post = await payload.create({
      collection: 'posts',
      data: { title: 'Post with Author', author: user.id },
    })

    expect(post.author).toBeDefined()
    // The author field should reference the user
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
    // Should have 3 tag references
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

    // The author should now reference user2
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
    // Password should not be returned
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

    // The token should be a valid JWT string (3 dot-separated base64 segments)
    const parts = loginResult.token!.split('.')
    expect(parts).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('pagination', () => {
  it('paginates results with limit', async () => {
    // Create 15 posts
    for (let i = 1; i <= 15; i++) {
      await payload.create({
        collection: 'posts',
        data: { title: `Paginated Post ${String(i).padStart(2, '0')}` },
      })
    }

    // Page 1 with limit 5
    const page1 = await payload.find({
      collection: 'posts',
      limit: 5,
      page: 1,
    })

    expect(page1.docs).toHaveLength(5)
    expect(page1.totalDocs).toBe(15)
    expect(page1.totalPages).toBe(3)
    expect(page1.page).toBe(1)
    expect(page1.hasNextPage).toBe(true)
    expect(page1.hasPrevPage).toBe(false)
    expect(page1.nextPage).toBe(2)
    expect(page1.prevPage).toBeNull()

    // Page 2
    const page2 = await payload.find({
      collection: 'posts',
      limit: 5,
      page: 2,
    })

    expect(page2.docs).toHaveLength(5)
    expect(page2.page).toBe(2)
    expect(page2.hasNextPage).toBe(true)
    expect(page2.hasPrevPage).toBe(true)
    expect(page2.prevPage).toBe(1)
    expect(page2.nextPage).toBe(3)

    // Page 3
    const page3 = await payload.find({
      collection: 'posts',
      limit: 5,
      page: 3,
    })

    expect(page3.docs).toHaveLength(5)
    expect(page3.hasNextPage).toBe(false)
    expect(page3.hasPrevPage).toBe(true)
    expect(page3.nextPage).toBeNull()

    // Ensure no overlap between pages
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
    const result = await payload.find({
      collection: 'posts',
      sort: 'title',
    })

    const titles = result.docs.map(d => d.title)
    expect(titles).toEqual(['Apple', 'Banana', 'Cherry'])
  })

  it('sorts by title descending', async () => {
    const result = await payload.find({
      collection: 'posts',
      sort: '-title',
    })

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

    // IDs should be sqid strings with prefix
    expect(typeof post.id).toBe('string')
    expect(post.id).toMatch(/^pos_/)

    // Should be decodable
    const decoded = fromSqid(post.id as string)
    expect(decoded.prefix).toBe('pos')
    expect(decoded.id).toBeGreaterThan(0)
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
    expect(result.totalPages).toBe(0)
    expect(result.hasNextPage).toBe(false)
    expect(result.hasPrevPage).toBe(false)
  })

  it('handles findByID for non-existent doc', async () => {
    // Payload should throw NotFound for invalid ID
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

    // Verify via findByID
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
