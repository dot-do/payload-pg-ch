/**
 * Phase 1 TDD tests: prefix registry, actions facade, versioned collections, noun compiler
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, createTestNs, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { fromSqid, getPrefix } from '../src/id/sqids.js'
import { query } from '../src/db/pg.js'
import type pg from 'pg'

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

let adapter: DocumentAdapter
let pool: pg.Pool
let ns: string

// Full collection registry for all 46 collections
const ALL_COLLECTIONS = [
  // Core
  { slug: 'nouns', prefix: 'nou', fields: [{ name: 'name', type: 'text' }, { name: 'schema', type: 'json' }] },
  { slug: 'verbs', prefix: 'vrb', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'things', prefix: 'thn', fields: [{ name: 'name', type: 'text' }, { name: 'noun', type: 'relationship', relationTo: 'nouns' }] },
  { slug: 'action-defs', prefix: 'acd', fields: [{ name: 'name', type: 'text' }, { name: 'noun', type: 'relationship', relationTo: 'nouns' }, { name: 'verb', type: 'relationship', relationTo: 'verbs' }] },
  // Chat
  { slug: 'chats', prefix: 'cht', fields: [{ name: 'title', type: 'text' }, { name: 'user', type: 'relationship', relationTo: 'users' }] },
  { slug: 'messages', prefix: 'msg', fields: [{ name: 'chat', type: 'relationship', relationTo: 'chats' }, { name: 'role', type: 'text' }, { name: 'parts', type: 'json' }] },
  { slug: 'votes', prefix: 'vot', fields: [{ name: 'message', type: 'relationship', relationTo: 'messages' }] },
  { slug: 'documents', prefix: 'doc', fields: [{ name: 'title', type: 'text' }, { name: 'content', type: 'textarea' }] },
  { slug: 'suggestions', prefix: 'sug', fields: [{ name: 'document', type: 'relationship', relationTo: 'documents' }] },
  { slug: 'streams', prefix: 'stm', fields: [{ name: 'chat', type: 'relationship', relationTo: 'chats' }] },
  // Agents
  { slug: 'agents', prefix: 'agt', fields: [{ name: 'name', type: 'text' }, { name: 'model', type: 'relationship', relationTo: 'models' }, { name: 'tools', type: 'relationship', relationTo: 'tools', hasMany: true }] },
  { slug: 'models', prefix: 'mdl', fields: [{ name: 'name', type: 'text' }, { name: 'modelId', type: 'text' }] },
  { slug: 'prompts', prefix: 'pmt', fields: [{ name: 'name', type: 'text' }, { name: 'template', type: 'code' }] },
  { slug: 'tools', prefix: 'tol', fields: [{ name: 'name', type: 'text' }, { name: 'function', type: 'relationship', relationTo: 'functions' }] },
  { slug: 'memories', prefix: 'mem', fields: [{ name: 'key', type: 'text' }, { name: 'agent', type: 'relationship', relationTo: 'agents' }] },
  { slug: 'agent-sessions', prefix: 'asn', fields: [{ name: 'agent', type: 'relationship', relationTo: 'agents' }] },
  // Code
  { slug: 'functions', prefix: 'fun', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'workflows', prefix: 'wfl', fields: [{ name: 'name', type: 'text' }, { name: 'steps', type: 'array', fields: [{ name: 'function', type: 'relationship', relationTo: 'functions' }] }] },
  { slug: 'packages', prefix: 'pkg', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'modules', prefix: 'mod', fields: [{ name: 'name', type: 'text' }, { name: 'package', type: 'relationship', relationTo: 'packages' }] },
  { slug: 'components', prefix: 'cmp', fields: [{ name: 'name', type: 'text' }] },
  // Orchestration
  { slug: 'issues', prefix: 'iss', fields: [{ name: 'title', type: 'text' }, { name: 'project', type: 'relationship', relationTo: 'projects' }, { name: 'assignedAgent', type: 'relationship', relationTo: 'agents' }] },
  { slug: 'projects', prefix: 'prj', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'goals', prefix: 'gol', fields: [{ name: 'title', type: 'text' }] },
  { slug: 'approvals', prefix: 'apr', fields: [{ name: 'title', type: 'text' }] },
  { slug: 'comments', prefix: 'cmn', fields: [{ name: 'body', type: 'textarea' }] },
  // Identity
  { slug: 'users', prefix: 'usr', fields: [{ name: 'email', type: 'email' }] },
  { slug: 'organizations', prefix: 'org', fields: [{ name: 'name', type: 'text' }, { name: 'parent', type: 'relationship', relationTo: 'organizations' }] },
  { slug: 'teams', prefix: 'tam', fields: [{ name: 'name', type: 'text' }, { name: 'lead', type: 'relationship', relationTo: 'users' }] },
  { slug: 'roles', prefix: 'rol', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'api-keys', prefix: 'key', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'accounts', prefix: 'acc', fields: [{ name: 'name', type: 'text' }, { name: 'owner', type: 'relationship', relationTo: 'users' }] },
  // Integrations
  { slug: 'integrations', prefix: 'int', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'connections', prefix: 'con', fields: [{ name: 'name', type: 'text' }, { name: 'integration', type: 'relationship', relationTo: 'integrations' }] },
  { slug: 'webhooks', prefix: 'whk', fields: [{ name: 'name', type: 'text' }] },
  // Discovery
  { slug: 'domains', prefix: 'dom', fields: [{ name: 'name', type: 'text' }, { name: 'parent', type: 'relationship', relationTo: 'domains' }] },
  { slug: 'directories', prefix: 'dir', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'sources', prefix: 'src', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'resources', prefix: 'rsc', fields: [{ name: 'name', type: 'text' }, { name: 'sources', type: 'relationship', relationTo: 'sources', hasMany: true }] },
  // Finance
  { slug: 'cost-events', prefix: 'cst', fields: [{ name: 'amount', type: 'number' }] },
  { slug: 'budget-policies', prefix: 'bgt', fields: [{ name: 'name', type: 'text' }] },
  // Media
  { slug: 'media', prefix: 'med', fields: [{ name: 'alt', type: 'text' }] },
] as const

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()
  adapter = new DocumentAdapter(
    { postgres: TEST_DB },
    ALL_COLLECTIONS.map(c => ({ slug: c.slug, prefix: c.prefix, fields: c.fields as any })),
  )
})

afterAll(async () => {
  await adapter.destroy()
  await teardownTestPool()
})

beforeEach(async () => {
  await cleanupTestData()
  ns = await createTestNs('phase1.test', 'Phase1')
  await adapter.nsResolver.refresh()
})

// ============================================================
// BEAD 6p9: Extend prefix registry for all 46 collections
// ============================================================
describe('prefix registry for all 42 collections', () => {
  it('every collection has a registered 3-char prefix', () => {
    for (const col of ALL_COLLECTIONS) {
      expect(getPrefix(col.slug)).toBe(col.prefix)
      expect(col.prefix.length).toBe(3)
    }
  })

  it('creates docs in every collection with correct sqid prefix', async () => {
    for (const col of ALL_COLLECTIONS) {
      const data: Record<string, unknown> = {}
      for (const f of col.fields) {
        if (f.type === 'text' || f.type === 'textarea' || f.type === 'email' || f.type === 'code') {
          data[f.name] = `test-${col.slug}`
        } else if (f.type === 'number') {
          data[f.name] = 42
        } else if (f.type === 'json') {
          data[f.name] = { test: true }
        }
      }
      const result = await adapter.create({ ns, type: col.slug, data })
      expect(result.id).toMatch(new RegExp(`^${col.prefix}_`))
    }
  })

  it('no prefix collisions across collections', () => {
    const seen = new Map<string, string>()
    for (const col of ALL_COLLECTIONS) {
      const prefix = getPrefix(col.slug)
      if (seen.has(prefix)) {
        throw new Error(`Prefix collision: ${col.slug} and ${seen.get(prefix)} both use '${prefix}'`)
      }
      seen.set(prefix, col.slug)
    }
  })
})

// ============================================================
// BEAD gyu: Actions table as collection facade
// ============================================================
describe('actions table as collection facade', () => {
  it('agent-runs are created in actions table, not data table', async () => {
    const agentRun = await adapter.create({
      ns,
      type: 'agent-runs',
      data: {
        type: 'agent-run',
        name: 'test-run',
        input: { agentId: 1, messages: [] },
      },
    })

    expect(agentRun.id).toMatch(/^arn_/)

    // Should NOT be in data table
    const dataResult = await query(pool, `SELECT id FROM data WHERE ns = $1 AND type = 'agent-runs'`, [ns])
    expect(dataResult.rows).toHaveLength(0)

    // Should BE in actions table
    const actionsResult = await query(pool, `SELECT id, type, name FROM actions WHERE ns = $1`, [ns])
    expect(actionsResult.rows).toHaveLength(1)
    expect(actionsResult.rows[0].type).toBe('agent-run')
  })

  it('agent-runs can be found and queried', async () => {
    await adapter.create({
      ns,
      type: 'agent-runs',
      data: { type: 'agent-run', name: 'run-1', status: 'pending' },
    })
    await adapter.create({
      ns,
      type: 'agent-runs',
      data: { type: 'agent-run', name: 'run-2', status: 'completed' },
    })

    const all = await adapter.find({ ns, type: 'agent-runs' })
    expect(all.total).toBe(2)
  })

  it('agent-runs support the dequeue/checkpoint/complete lifecycle', async () => {
    const run = await adapter.create({
      ns,
      type: 'agent-runs',
      data: { type: 'agent-run', name: 'lifecycle-test' },
    })

    // Dequeue
    const dequeued = await adapter.dequeue({ ns, type: 'agent-run', limit: 1 })
    expect(dequeued).toHaveLength(1)

    // Checkpoint
    await adapter.checkpoint({ id: run.id, step: 1, result: { tool: 'read', output: 'file.ts' } })

    // Complete
    await adapter.complete({ id: run.id, output: { success: true } })

    const intId = fromSqid(run.id).seq
    const final = await query<{ status: string }>(pool, `SELECT status FROM actions WHERE seq = $1`, [intId])
    expect(final.rows[0].status).toBe('completed')
  })
})


// ============================================================
// BEAD vqp: Noun schema to CollectionConfig compiler
// ============================================================
describe('noun schema to CollectionConfig compiler', () => {
  // Import will fail until implemented — that's RED phase
  it('compiles text, number, date fields', async () => {
    const { nounToCollectionConfig } = await import('../src/nouns/compiler.js')

    const config = nounToCollectionConfig('Contact', {
      fields: [
        { name: 'firstName', type: 'text', required: true },
        { name: 'age', type: 'number' },
        { name: 'birthDate', type: 'date' },
        { name: 'bio', type: 'textarea' },
        { name: 'active', type: 'checkbox' },
      ],
    })

    expect(config.slug).toBe('contact')
    expect(config.fields.length).toBeGreaterThanOrEqual(5)
    const textField = config.fields.find((f: any) => f.name === 'firstName')
    expect(textField?.type).toBe('text')
    expect(textField?.required).toBe(true)
  })

  it('compiles relationship fields', async () => {
    const { nounToCollectionConfig } = await import('../src/nouns/compiler.js')

    const config = nounToCollectionConfig('Invoice', {
      fields: [
        { name: 'customer', type: 'relationship', relationTo: 'contacts' },
        { name: 'items', type: 'relationship', relationTo: 'products', hasMany: true },
      ],
    })

    const customerField = config.fields.find((f: any) => f.name === 'customer') as any
    expect(customerField?.type).toBe('relationship')
    expect(customerField?.relationTo).toBe('contacts')

    const itemsField = config.fields.find((f: any) => f.name === 'items') as any
    expect(itemsField?.hasMany).toBe(true)
  })

  it('compiles select/array/group fields', async () => {
    const { nounToCollectionConfig } = await import('../src/nouns/compiler.js')

    const config = nounToCollectionConfig('Order', {
      fields: [
        { name: 'status', type: 'select', options: ['pending', 'shipped', 'delivered'] },
        { name: 'lines', type: 'array', fields: [
          { name: 'product', type: 'text' },
          { name: 'qty', type: 'number' },
        ]},
        { name: 'address', type: 'group', fields: [
          { name: 'street', type: 'text' },
          { name: 'city', type: 'text' },
        ]},
      ],
    })

    const selectField = config.fields.find((f: any) => f.name === 'status') as any
    expect(selectField?.type).toBe('select')
    expect(selectField?.options).toContain('pending')

    const arrayField = config.fields.find((f: any) => f.name === 'lines') as any
    expect(arrayField?.type).toBe('array')
    expect(arrayField?.fields).toHaveLength(2)

    const groupField = config.fields.find((f: any) => f.name === 'address') as any
    expect(groupField?.type).toBe('group')
  })

  it('generates valid slug from noun name', async () => {
    const { nounToCollectionConfig } = await import('../src/nouns/compiler.js')

    expect(nounToCollectionConfig('Contact', { fields: [] }).slug).toBe('contact')
    expect(nounToCollectionConfig('Line Item', { fields: [] }).slug).toBe('line-item')
    expect(nounToCollectionConfig('API Key', { fields: [] }).slug).toBe('api-key')
  })
})
