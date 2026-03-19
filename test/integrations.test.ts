import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, teardownTestPool } from './setup.js'
import { query } from '../src/db/pg.js'
import { handleStripeWebhook } from '../src/integrations/stripe/webhooks.js'
import { handlePullRequest, handlePush } from '../src/integrations/github/webhooks.js'
import type pg from 'pg'

let pool: pg.Pool
let nsId: number

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()
})

afterAll(async () => {
  await teardownTestPool()
})

beforeEach(async () => {
  await cleanupTestData()
  const result = await query<{ id: number }>(
    pool,
    `INSERT INTO ns (uri, name, kind, repo, branch, stripe, plan)
     VALUES ('int.test', 'Integration', 'production', 'org/repo', 'main', 'cus_123', 'pro')
     RETURNING id`,
  )
  nsId = result.rows[0].id
})

describe('Stripe webhook handler', () => {
  it('logs stripe events to log table', async () => {
    await handleStripeWebhook(pool, {
      id: 'evt_test_1',
      type: 'invoice.paid',
      data: {
        object: {
          amount: 2999,
          metadata: { nsId: String(nsId) },
        },
      },
    })

    const logs = await query<{ kind: string; meta: Record<string, unknown> }>(
      pool,
      `SELECT kind, meta FROM log WHERE ns = $1`,
      [nsId],
    )
    expect(logs.rows).toHaveLength(1)
    expect(logs.rows[0].kind).toBe('stripe.invoice.paid')
    expect(logs.rows[0].meta.amount).toBe(2999)
  })

  it('updates plan on subscription.updated', async () => {
    await handleStripeWebhook(pool, {
      id: 'evt_test_2',
      type: 'customer.subscription.updated',
      data: {
        object: {
          status: 'active',
          items: { data: [{ price: { id: 'price_enterprise_monthly' } }] },
          metadata: { nsId: String(nsId) },
        },
      },
    })

    const ns = await query<{ plan: string }>(pool, `SELECT plan FROM ns WHERE id = $1`, [nsId])
    expect(ns.rows[0].plan).toBe('enterprise')
  })

  it('downgrades plan on subscription.deleted', async () => {
    await handleStripeWebhook(pool, {
      id: 'evt_test_3',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          status: 'canceled',
          items: { data: [{ price: { id: 'price_pro' } }] },
          metadata: { nsId: String(nsId) },
        },
      },
    })

    const ns = await query<{ plan: string }>(pool, `SELECT plan FROM ns WHERE id = $1`, [nsId])
    expect(ns.rows[0].plan).toBe('free')
  })

  it('updates onboarded on account.updated', async () => {
    await handleStripeWebhook(pool, {
      id: 'evt_test_4',
      type: 'account.updated',
      data: {
        object: {
          charges_enabled: true,
          metadata: { nsId: String(nsId) },
        },
      },
    })

    const ns = await query<{ onboarded: boolean }>(pool, `SELECT onboarded FROM ns WHERE id = $1`, [nsId])
    expect(ns.rows[0].onboarded).toBe(true)
  })

  it('ignores events without nsId metadata', async () => {
    await handleStripeWebhook(pool, {
      id: 'evt_test_5',
      type: 'charge.succeeded',
      data: {
        object: { amount: 1000 },
      },
    })

    const logs = await query(pool, `SELECT id FROM log WHERE ns = $1`, [nsId])
    expect(logs.rows).toHaveLength(0)
  })
})

describe('GitHub webhook handler - pull_request', () => {
  it('creates preview namespace on PR opened', async () => {
    await handlePullRequest(pool, {
      action: 'opened',
      number: 42,
      pull_request: {
        head: { ref: 'feat/new-hero' },
        base: { ref: 'main' },
        merged: false,
      },
      repository: { full_name: 'org/repo' },
    })

    const preview = await query<{ uri: string; kind: string; pr: number; parent: number }>(
      pool,
      `SELECT uri, kind, pr, parent FROM ns WHERE kind = 'preview'`,
    )
    expect(preview.rows).toHaveLength(1)
    expect(preview.rows[0].uri).toBe('int.test/pr/42')
    expect(preview.rows[0].kind).toBe('preview')
    expect(preview.rows[0].pr).toBe(42)
    expect(preview.rows[0].parent).toBe(nsId)

    // Should also emit a log event
    const logs = await query<{ kind: string }>(
      pool,
      `SELECT kind FROM log WHERE ns = $1 AND kind = 'preview.created'`,
      [nsId],
    )
    expect(logs.rows).toHaveLength(1)
  })

  it('does not create duplicate preview on reopened', async () => {
    // Open
    await handlePullRequest(pool, {
      action: 'opened',
      number: 43,
      pull_request: { head: { ref: 'feat/x' }, base: { ref: 'main' }, merged: false },
      repository: { full_name: 'org/repo' },
    })

    // Reopen
    await handlePullRequest(pool, {
      action: 'reopened',
      number: 43,
      pull_request: { head: { ref: 'feat/x' }, base: { ref: 'main' }, merged: false },
      repository: { full_name: 'org/repo' },
    })

    const previews = await query(pool, `SELECT id FROM ns WHERE kind = 'preview'`)
    expect(previews.rows).toHaveLength(1)
  })

  it('cleans up on PR closed without merge', async () => {
    // Create preview
    await handlePullRequest(pool, {
      action: 'opened',
      number: 44,
      pull_request: { head: { ref: 'feat/y' }, base: { ref: 'main' }, merged: false },
      repository: { full_name: 'org/repo' },
    })

    // Close without merge
    await handlePullRequest(pool, {
      action: 'closed',
      number: 44,
      pull_request: { head: { ref: 'feat/y' }, base: { ref: 'main' }, merged: false },
      repository: { full_name: 'org/repo' },
    })

    const previews = await query(pool, `SELECT id FROM ns WHERE kind = 'preview'`)
    expect(previews.rows).toHaveLength(0)

    // Should emit cleanup event
    const logs = await query<{ kind: string }>(
      pool,
      `SELECT kind FROM log WHERE ns = $1 AND kind = 'preview.cleaned'`,
      [nsId],
    )
    expect(logs.rows).toHaveLength(1)
  })

  it('ignores PRs for untracked repos', async () => {
    await handlePullRequest(pool, {
      action: 'opened',
      number: 99,
      pull_request: { head: { ref: 'feat/z' }, base: { ref: 'main' }, merged: false },
      repository: { full_name: 'other/repo' },
    })

    const previews = await query(pool, `SELECT id FROM ns WHERE kind = 'preview'`)
    expect(previews.rows).toHaveLength(0)
  })
})

describe('GitHub webhook handler - push', () => {
  it('emits push event for tracked branch', async () => {
    await handlePush(pool, {
      ref: 'refs/heads/main',
      after: 'abc123def456',
      repository: { full_name: 'org/repo' },
    })

    const logs = await query<{ kind: string; meta: Record<string, unknown> }>(
      pool,
      `SELECT kind, meta FROM log WHERE ns = $1 AND kind = 'github.push'`,
      [nsId],
    )
    expect(logs.rows).toHaveLength(1)
    expect(logs.rows[0].meta.commit).toBe('abc123def456')
    expect(logs.rows[0].meta.branch).toBe('main')
  })

  it('ignores pushes to untracked branches', async () => {
    await handlePush(pool, {
      ref: 'refs/heads/develop',
      after: 'abc123',
      repository: { full_name: 'org/repo' },
    })

    const logs = await query(pool, `SELECT id FROM log WHERE ns = $1 AND kind = 'github.push'`, [nsId])
    expect(logs.rows).toHaveLength(0)
  })

  it('ignores pushes to untracked repos', async () => {
    await handlePush(pool, {
      ref: 'refs/heads/main',
      after: 'abc123',
      repository: { full_name: 'other/repo' },
    })

    const logs = await query(pool, `SELECT id FROM log WHERE kind = 'github.push'`)
    expect(logs.rows).toHaveLength(0)
  })
})
