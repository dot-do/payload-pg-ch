import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, createTestNs, teardownTestPool } from './setup.js'
import { query, transaction } from '../src/db/pg.js'
import { insertSearch, searchByEmbedding } from '../src/db/queries/search.js'
import { dropOldLogPartitions } from '../src/workers/retention.js'
import { createNsHook, createActorHook } from '../src/payload/hooks.js'
import { NsResolver } from '../src/ns/resolver.js'
import { eventsCollection, versionsCollection, usersCollection, nsCollection } from '../src/payload/config.js'
import type pg from 'pg'

let pool: pg.Pool
let ns: string

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()
})

afterAll(async () => {
  await teardownTestPool()
})

beforeEach(async () => {
  await cleanupTestData()
  ns = await createTestNs('search-emb.test', 'Test')
})

describe('searchByEmbedding', () => {
  it('finds search entries by vector similarity', async () => {
    const dim = 3072
    const emb1 = new Array(dim).fill(0); emb1[0] = 1
    const emb2 = new Array(dim).fill(0); emb2[1] = 1

    await transaction(pool, async (tx) => {
      await insertSearch(tx, {
        ns, entity: 1, type: 'posts', version: 1,
        name: 'Similar', embedding: emb1,
      })
      await insertSearch(tx, {
        ns, entity: 2, type: 'posts', version: 1,
        name: 'Different', embedding: emb2,
      })
    })

    const results = await searchByEmbedding(pool, {
      ns,
      embedding: emb1,
      limit: 2,
    })

    expect(results.rows).toHaveLength(2)
    expect(results.scores[0]).toBeLessThanOrEqual(results.scores[1])
    expect(results.rows[0].name).toBe('Similar')
  })

  it('filters by collection', async () => {
    const dim = 3072
    const emb = new Array(dim).fill(0); emb[0] = 1

    await transaction(pool, async (tx) => {
      await insertSearch(tx, {
        ns, entity: 1, type: 'posts', version: 1,
        name: 'Post', embedding: emb,
      })
      await insertSearch(tx, {
        ns, entity: 2, type: 'pages', version: 1,
        name: 'Page', embedding: emb,
      })
    })

    const results = await searchByEmbedding(pool, {
      ns,
      type: 'posts',
      embedding: emb,
      limit: 10,
    })

    expect(results.rows).toHaveLength(1)
    expect(results.rows[0].name).toBe('Post')
  })
})

describe('dropOldLogPartitions', () => {
  it('returns empty array when no old partitions exist', async () => {
    const dropped = await dropOldLogPartitions(pool, 90)
    expect(Array.isArray(dropped)).toBe(true)
    // We only have log_default and log_current, neither matches log_YYYYMM
    expect(dropped).toHaveLength(0)
  })
})

describe('payload hooks', () => {
  it('createNsHook resolves namespace from request', async () => {
    const resolver = new NsResolver(pool)
    await resolver.refresh()

    const hook = createNsHook(resolver)
    const ctx = await hook({
      req: { headers: { host: 'search-emb.test' }, url: '/api/posts' },
    })

    expect(ctx.ns).not.toBeUndefined()
    expect(ctx.ns!.ns).toBe(ns)

    resolver.stop()
  })

  it('createActorHook injects user id', async () => {
    const hook = createActorHook()
    const ctx = await hook({
      req: { headers: {} },
      user: { id: 42 },
    })

    expect(ctx.actor).toBe(42)
  })

  it('createActorHook handles missing user', async () => {
    const hook = createActorHook()
    const ctx = await hook({ req: { headers: {} } })
    expect(ctx.actor).toBeUndefined()
  })
})

describe('payload collection configs', () => {
  it('eventsCollection returns correct shape', () => {
    const col = eventsCollection()
    expect(col.slug).toBe('events')
    expect(col.admin.readOnly).toBe(true)
    expect(col.fields.length).toBeGreaterThan(0)
  })

  it('versionsCollection returns correct shape', () => {
    const col = versionsCollection()
    expect(col.slug).toBe('versions')
    expect(col.admin.readOnly).toBe(true)
  })

  it('usersCollection has auth config', () => {
    const col = usersCollection()
    expect(col.slug).toBe('users')
    expect(col.auth.disableLocalStrategy).toBe(true)
  })

  it('usersCollection allows local strategy', () => {
    const col = usersCollection({ disableLocal: false })
    expect(col.auth.disableLocalStrategy).toBe(false)
  })

  it('nsCollection has uri field', () => {
    const col = nsCollection()
    expect(col.slug).toBe('namespaces')
    expect(col.fields.some(f => f.name === 'uri')).toBe(true)
  })
})
