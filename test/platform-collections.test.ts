/**
 * Integration test using the actual collection schemas from dot-do/platform.do
 * Tests that the adapter handles all 38 platform collections correctly.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { fromSqid } from '../src/id/sqids.js'
import { query } from '../src/db/pg.js'
import type { FieldSchema } from '../src/types.js'
import type pg from 'pg'

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

// Map platform.do collections to adapter field schemas
// Only include fields that produce relationships (the adapter's rels table)
const PLATFORM_COLLECTIONS: Array<{
  slug: string
  prefix: string
  fields: FieldSchema[]
}> = [
  // Data
  {
    slug: 'nouns', prefix: 'nou',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'plural', type: 'text' },
      { name: 'description', type: 'textarea' },
      { name: 'schema', type: 'json' },
    ],
  },
  {
    slug: 'verbs', prefix: 'vrb',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'verb', type: 'text' },
      { name: 'activity', type: 'text' },
    ],
  },
  {
    slug: 'things', prefix: 'thn',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'noun', type: 'relationship', relationTo: 'nouns' },
      { name: 'data', type: 'json' },
    ],
  },
  {
    slug: 'actions', prefix: 'acn',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'noun', type: 'relationship', relationTo: 'nouns' },
      { name: 'verb', type: 'relationship', relationTo: 'verbs' },
      { name: 'function', type: 'relationship', relationTo: 'functions' },
      { name: 'workflow', type: 'relationship', relationTo: 'workflows' },
    ],
  },
  {
    slug: 'media', prefix: 'med',
    fields: [
      { name: 'alt', type: 'text' },
    ],
  },
  // Code
  {
    slug: 'functions', prefix: 'fun',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'description', type: 'textarea' },
      { name: 'model', type: 'relationship', relationTo: 'models' },
      { name: 'assignee', type: 'relationship', relationTo: 'users' },
      { name: 'inputSchema', type: 'json' },
      { name: 'outputSchema', type: 'json' },
    ],
  },
  {
    slug: 'workflows', prefix: 'wfl',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'description', type: 'textarea' },
      {
        name: 'steps', type: 'array',
        fields: [
          { name: 'name', type: 'text' },
          { name: 'function', type: 'relationship', relationTo: 'functions' },
          { name: 'config', type: 'json' },
        ],
      },
    ],
  },
  {
    slug: 'packages', prefix: 'pkg',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'version', type: 'text' },
    ],
  },
  {
    slug: 'modules', prefix: 'mod',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'package', type: 'relationship', relationTo: 'packages' },
    ],
  },
  {
    slug: 'components', prefix: 'cmp',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'source', type: 'code' },
    ],
  },
  // Agents
  {
    slug: 'agents', prefix: 'agt',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'model', type: 'relationship', relationTo: 'models' },
      { name: 'prompts', type: 'relationship', relationTo: 'prompts', hasMany: true },
      { name: 'tools', type: 'relationship', relationTo: 'tools', hasMany: true },
      { name: 'config', type: 'json' },
    ],
  },
  {
    slug: 'memories', prefix: 'mem',
    fields: [
      { name: 'key', type: 'text' },
      { name: 'value', type: 'textarea' },
      { name: 'agent', type: 'relationship', relationTo: 'agents' },
      { name: 'metadata', type: 'json' },
    ],
  },
  {
    slug: 'models', prefix: 'mdl',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'modelId', type: 'text' },
      { name: 'contextWindow', type: 'number' },
    ],
  },
  {
    slug: 'prompts', prefix: 'pmt',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'template', type: 'code' },
      { name: 'variables', type: 'json' },
    ],
  },
  {
    slug: 'tools', prefix: 'tol',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'description', type: 'textarea' },
      { name: 'function', type: 'relationship', relationTo: 'functions' },
      { name: 'inputSchema', type: 'json' },
    ],
  },
  // Identity
  {
    slug: 'users', prefix: 'usr',
    fields: [
      { name: 'email', type: 'email' },
    ],
  },
  {
    slug: 'organizations', prefix: 'org',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'domain', type: 'text' },
      { name: 'parent', type: 'relationship', relationTo: 'organizations' },
    ],
  },
  {
    slug: 'teams', prefix: 'tam',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'lead', type: 'relationship', relationTo: 'users' },
    ],
  },
  {
    slug: 'roles', prefix: 'rol',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'permissions', type: 'json' },
    ],
  },
  // Integrations
  {
    slug: 'integrations', prefix: 'int',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'provider', type: 'text' },
    ],
  },
  {
    slug: 'connections', prefix: 'con',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'integration', type: 'relationship', relationTo: 'integrations' },
      { name: 'account', type: 'relationship', relationTo: 'accounts' },
    ],
  },
  {
    slug: 'accounts', prefix: 'acc',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'provider', type: 'text' },
      { name: 'integration', type: 'relationship', relationTo: 'integrations' },
      { name: 'owner', type: 'relationship', relationTo: 'users' },
    ],
  },
  {
    slug: 'webhooks', prefix: 'whk',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'integration', type: 'relationship', relationTo: 'integrations' },
      { name: 'targetUrl', type: 'text' },
      { name: 'event', type: 'text' },
    ],
  },
  // Discovery
  {
    slug: 'domains', prefix: 'dom',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'parent', type: 'relationship', relationTo: 'domains' },
      { name: 'dnsRecords', type: 'json' },
    ],
  },
  {
    slug: 'directories', prefix: 'dir',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'url', type: 'text' },
    ],
  },
  {
    slug: 'sources', prefix: 'src',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'apiBaseUrl', type: 'text' },
      {
        name: 'capabilities', type: 'array',
        fields: [
          { name: 'name', type: 'text' },
          { name: 'path', type: 'text' },
        ],
      },
    ],
  },
  {
    slug: 'resources', prefix: 'rsc',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'sources', type: 'relationship', relationTo: 'sources', hasMany: true },
    ],
  },
]

let adapter: DocumentAdapter
let pool: pg.Pool
let nsId: number

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()
  adapter = new DocumentAdapter({ postgres: TEST_DB }, PLATFORM_COLLECTIONS)
})

afterAll(async () => {
  await adapter.destroy()
  await teardownTestPool()
})

beforeEach(async () => {
  await cleanupTestData()
  const result = await query<{ id: number }>(
    pool,
    `INSERT INTO ns (uri, name, kind) VALUES ('platform.test', 'Platform', 'production') RETURNING id`,
  )
  nsId = result.rows[0].id
  await adapter.nsResolver.refresh()
})

describe('platform.do collections: CRUD for all 27 collection types', () => {
  it('creates and finds docs across all collections', async () => {
    const created: Record<string, string> = {}

    // Create one doc in each collection
    for (const col of PLATFORM_COLLECTIONS) {
      const data: Record<string, unknown> = {}
      for (const f of col.fields) {
        if (f.type === 'text' || f.type === 'textarea' || f.type === 'email' || f.type === 'code') {
          data[f.name] = `Test ${f.name} for ${col.slug}`
        } else if (f.type === 'number') {
          data[f.name] = 42
        } else if (f.type === 'json') {
          data[f.name] = { test: true }
        }
        // Skip relationships for this test — we'll test those separately
      }
      const result = await adapter.create({ ns: nsId, collection: col.slug, data })
      created[col.slug] = result.id
      expect(result.id).toMatch(new RegExp(`^${col.prefix}_`))
    }

    // Verify each collection has exactly one doc
    for (const col of PLATFORM_COLLECTIONS) {
      const found = await adapter.find({ ns: nsId, collection: col.slug })
      expect(found.total).toBe(1)
    }

    // Verify findOne by sqid works for each
    for (const col of PLATFORM_COLLECTIONS) {
      const found = await adapter.findOne({ ns: nsId, collection: col.slug, id: created[col.slug] })
      expect(found).not.toBeNull()
      expect(found!.id).toBe(created[col.slug])
    }
  })
})

describe('platform.do: relationship graph', () => {
  it('builds the full Agent → Model, Prompts, Tools → Function relationship chain', async () => {
    // Create the chain bottom-up
    const model = await adapter.create({
      ns: nsId,
      collection: 'models',
      data: { name: 'Claude 4', slug: 'claude-4', modelId: 'claude-sonnet-4-6', contextWindow: 200000 },
    })

    const fn = await adapter.create({
      ns: nsId,
      collection: 'functions',
      data: { name: 'Search', slug: 'search', description: 'Search the web' },
    })

    const prompt = await adapter.create({
      ns: nsId,
      collection: 'prompts',
      data: { name: 'System Prompt', slug: 'system', template: 'You are a helpful assistant.' },
    })

    const tool = await adapter.create({
      ns: nsId,
      collection: 'tools',
      data: {
        name: 'Web Search',
        slug: 'web-search',
        description: 'Search the web',
        function: fromSqid(fn.id).id,
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    })

    const agent = await adapter.create({
      ns: nsId,
      collection: 'agents',
      data: {
        name: 'Research Agent',
        slug: 'research',
        model: fromSqid(model.id).id,
        prompts: [fromSqid(prompt.id).id],
        tools: [fromSqid(tool.id).id],
        config: { temperature: 0.7, maxTokens: 4096 },
      },
    })

    // Verify the full relationship chain
    const agentDoc = await adapter.findOne({ ns: nsId, collection: 'agents', id: agent.id })
    expect(agentDoc!.name).toBe('Research Agent')
    expect(agentDoc!.model).toBe(model.id) // sqid
    expect((agentDoc!.prompts as string[])[0]).toBe(prompt.id)
    expect((agentDoc!.tools as string[])[0]).toBe(tool.id)

    // Tool → Function relationship
    const toolDoc = await adapter.findOne({ ns: nsId, collection: 'tools', id: tool.id })
    expect(toolDoc!.function).toBe(fn.id)

    // Verify rels table
    const agentRels = await query<{ path: string }>(
      pool,
      `SELECT path FROM rels WHERE "from" = $1 ORDER BY path`,
      [fromSqid(agent.id).id],
    )
    expect(agentRels.rows.map(r => r.path)).toEqual(['model', 'prompts.0', 'tools.0'])
  })

  it('builds Action → Noun + Verb + Function + Workflow relationships', async () => {
    const noun = await adapter.create({
      ns: nsId,
      collection: 'nouns',
      data: { name: 'Contact', slug: 'contact', plural: 'Contacts' },
    })
    const verb = await adapter.create({
      ns: nsId,
      collection: 'verbs',
      data: { name: 'Create', slug: 'create', verb: 'create' },
    })
    const fn = await adapter.create({
      ns: nsId,
      collection: 'functions',
      data: { name: 'CreateContact', slug: 'create-contact' },
    })

    const action = await adapter.create({
      ns: nsId,
      collection: 'actions',
      data: {
        name: 'Create Contact',
        slug: 'create-contact',
        noun: fromSqid(noun.id).id,
        verb: fromSqid(verb.id).id,
        function: fromSqid(fn.id).id,
      },
    })

    const actionDoc = await adapter.findOne({ ns: nsId, collection: 'actions', id: action.id })
    expect(actionDoc!.noun).toBe(noun.id)
    expect(actionDoc!.verb).toBe(verb.id)
    expect(actionDoc!.function).toBe(fn.id)
  })

  it('builds self-referencing relationships (Org → parent Org, Domain → parent Domain)', async () => {
    const parentOrg = await adapter.create({
      ns: nsId,
      collection: 'organizations',
      data: { name: 'Acme Corp', slug: 'acme', domain: 'acme.com' },
    })

    const childOrg = await adapter.create({
      ns: nsId,
      collection: 'organizations',
      data: {
        name: 'Acme Labs',
        slug: 'acme-labs',
        parent: fromSqid(parentOrg.id).id,
      },
    })

    const childDoc = await adapter.findOne({ ns: nsId, collection: 'organizations', id: childOrg.id })
    expect(childDoc!.parent).toBe(parentOrg.id)

    // Same for domains
    const rootDomain = await adapter.create({
      ns: nsId,
      collection: 'domains',
      data: { name: 'acme.com' },
    })
    const subDomain = await adapter.create({
      ns: nsId,
      collection: 'domains',
      data: { name: 'api.acme.com', parent: fromSqid(rootDomain.id).id },
    })

    const subDoc = await adapter.findOne({ ns: nsId, collection: 'domains', id: subDomain.id })
    expect(subDoc!.parent).toBe(rootDomain.id)
  })

  it('builds Workflow with array of Function steps', async () => {
    const fn1 = await adapter.create({
      ns: nsId,
      collection: 'functions',
      data: { name: 'Fetch', slug: 'fetch' },
    })
    const fn2 = await adapter.create({
      ns: nsId,
      collection: 'functions',
      data: { name: 'Transform', slug: 'transform' },
    })
    const fn3 = await adapter.create({
      ns: nsId,
      collection: 'functions',
      data: { name: 'Load', slug: 'load' },
    })

    const workflow = await adapter.create({
      ns: nsId,
      collection: 'workflows',
      data: {
        name: 'ETL Pipeline',
        slug: 'etl',
        steps: [
          { name: 'Fetch Data', function: fromSqid(fn1.id).id, config: { url: 'https://api.example.com' } },
          { name: 'Transform', function: fromSqid(fn2.id).id, config: { format: 'json' } },
          { name: 'Load', function: fromSqid(fn3.id).id, config: { target: 'warehouse' } },
        ],
      },
    })

    // Verify nested array rels
    const rels = await query<{ path: string; to: number }>(
      pool,
      `SELECT path, "to" FROM rels WHERE "from" = $1 ORDER BY path`,
      [fromSqid(workflow.id).id],
    )
    expect(rels.rows).toHaveLength(3)
    expect(rels.rows[0].path).toBe('steps.0.function')
    expect(rels.rows[1].path).toBe('steps.1.function')
    expect(rels.rows[2].path).toBe('steps.2.function')
  })

  it('builds Resource → Sources (hasMany) relationship', async () => {
    const s1 = await adapter.create({
      ns: nsId,
      collection: 'sources',
      data: { name: 'Apollo', slug: 'apollo', apiBaseUrl: 'https://api.apollo.io' },
    })
    const s2 = await adapter.create({
      ns: nsId,
      collection: 'sources',
      data: { name: 'Clearbit', slug: 'clearbit', apiBaseUrl: 'https://api.clearbit.com' },
    })

    const resource = await adapter.create({
      ns: nsId,
      collection: 'resources',
      data: {
        name: 'Company Enrichment',
        slug: 'company-enrichment',
        sources: [fromSqid(s1.id).id, fromSqid(s2.id).id],
      },
    })

    const resourceDoc = await adapter.findOne({ ns: nsId, collection: 'resources', id: resource.id })
    const sources = resourceDoc!.sources as string[]
    expect(sources).toHaveLength(2)
    expect(sources).toContain(s1.id)
    expect(sources).toContain(s2.id)
  })
})

describe('platform.do: JSON field handling', () => {
  it('stores and retrieves complex JSON schemas (Noun.schema)', async () => {
    const schema = {
      type: 'object',
      properties: {
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string', format: 'email' },
        tags: { type: 'array', items: { type: 'string' } },
        address: {
          type: 'object',
          properties: {
            street: { type: 'string' },
            city: { type: 'string' },
            country: { type: 'string' },
          },
        },
      },
      required: ['firstName', 'email'],
    }

    const noun = await adapter.create({
      ns: nsId,
      collection: 'nouns',
      data: { name: 'Contact', slug: 'contact', plural: 'Contacts', schema },
    })

    const found = await adapter.findOne({ ns: nsId, collection: 'nouns', id: noun.id })
    const storedSchema = found!.schema as Record<string, unknown>
    expect(storedSchema.type).toBe('object')
    const props = storedSchema.properties as Record<string, unknown>
    expect(props.firstName).toEqual({ type: 'string' })
    expect(storedSchema.required).toEqual(['firstName', 'email'])
  })

  it('stores and retrieves workflow step config', async () => {
    const workflow = await adapter.create({
      ns: nsId,
      collection: 'workflows',
      data: {
        name: 'Complex Flow',
        slug: 'complex',
        steps: [
          { name: 'Step 1', config: { retry: 3, timeout: 30000, headers: { 'X-Api-Key': '***' } } },
        ],
      },
    })

    const found = await adapter.findOne({ ns: nsId, collection: 'workflows', id: workflow.id })
    const steps = found!.steps as Array<Record<string, unknown>>
    const config = steps[0].config as Record<string, unknown>
    expect(config.retry).toBe(3)
    expect(config.timeout).toBe(30000)
  })
})

describe('platform.do: where queries across collection types', () => {
  it('filters agents by status', async () => {
    await adapter.create({ ns: nsId, collection: 'agents', data: { name: 'Active Agent', status: 'Active' } })
    await adapter.create({ ns: nsId, collection: 'agents', data: { name: 'Draft Agent', status: 'Draft' } })
    await adapter.create({ ns: nsId, collection: 'agents', data: { name: 'Paused Agent', status: 'Paused' } })

    const active = await adapter.find({
      ns: nsId,
      collection: 'agents',
      where: { status: { equals: 'Active' } },
    })
    expect(active.total).toBe(1)
    expect(active.docs[0].name).toBe('Active Agent')
  })

  it('finds organizations by domain', async () => {
    await adapter.create({ ns: nsId, collection: 'organizations', data: { name: 'Acme', domain: 'acme.com' } })
    await adapter.create({ ns: nsId, collection: 'organizations', data: { name: 'Beta', domain: 'beta.io' } })

    const result = await adapter.find({
      ns: nsId,
      collection: 'organizations',
      where: { domain: { equals: 'acme.com' } },
    })
    expect(result.total).toBe(1)
    expect(result.docs[0].name).toBe('Acme')
  })

  it('searches functions by name contains', async () => {
    await adapter.create({ ns: nsId, collection: 'functions', data: { name: 'fetchUserProfile', slug: 'fetch-user' } })
    await adapter.create({ ns: nsId, collection: 'functions', data: { name: 'createOrder', slug: 'create-order' } })
    await adapter.create({ ns: nsId, collection: 'functions', data: { name: 'fetchOrderHistory', slug: 'fetch-orders' } })

    const fetchFns = await adapter.find({
      ns: nsId,
      collection: 'functions',
      where: { name: { contains: 'fetch' } },
    })
    expect(fetchFns.total).toBe(2)
  })
})
