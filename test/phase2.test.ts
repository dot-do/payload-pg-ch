/**
 * Phase 2 TDD tests: Chat, Agents, Issues, Cost Events, Dynamic Nouns
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, createTestNs, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { fromSqid } from '../src/id/sqids.js'
import { query, transaction } from '../src/db/pg.js'
import { insertData } from '../src/db/queries/data.js'
import type pg from 'pg'

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

// Full collection set (same as phase1)
const COLLECTIONS = [
  { slug: 'nouns', prefix: 'nou', versioned: true, fields: [{ name: 'name', type: 'text' }, { name: 'slug', type: 'text' }, { name: 'plural', type: 'text' }, { name: 'schema', type: 'json' }] },
  { slug: 'chats', prefix: 'cht', fields: [{ name: 'title', type: 'text' }, { name: 'user', type: 'relationship', relationTo: 'users' }] },
  { slug: 'messages', prefix: 'msg', fields: [{ name: 'chat', type: 'relationship', relationTo: 'chats' }, { name: 'role', type: 'text' }, { name: 'parts', type: 'json' }] },
  { slug: 'votes', prefix: 'vot', fields: [{ name: 'message', type: 'relationship', relationTo: 'messages' }, { name: 'vote', type: 'text' }] },
  { slug: 'documents', prefix: 'doc', versioned: true, fields: [{ name: 'title', type: 'text' }, { name: 'content', type: 'textarea' }, { name: 'kind', type: 'text' }] },
  { slug: 'suggestions', prefix: 'sug', fields: [{ name: 'document', type: 'relationship', relationTo: 'documents' }, { name: 'originalText', type: 'textarea' }, { name: 'suggestedText', type: 'textarea' }] },
  { slug: 'streams', prefix: 'stm', fields: [{ name: 'chat', type: 'relationship', relationTo: 'chats' }, { name: 'streamId', type: 'text' }, { name: 'status', type: 'text' }] },
  { slug: 'agents', prefix: 'agt', versioned: true, fields: [
    { name: 'name', type: 'text' }, { name: 'slug', type: 'text' },
    { name: 'model', type: 'relationship', relationTo: 'models' },
    { name: 'prompts', type: 'relationship', relationTo: 'prompts', hasMany: true },
    { name: 'tools', type: 'relationship', relationTo: 'tools', hasMany: true },
    { name: 'subAgents', type: 'relationship', relationTo: 'agents', hasMany: true },
    { name: 'config', type: 'json' },
    { name: 'permissions', type: 'json' },
  ] },
  { slug: 'models', prefix: 'mdl', fields: [{ name: 'name', type: 'text' }, { name: 'modelId', type: 'text' }, { name: 'provider', type: 'text' }] },
  { slug: 'prompts', prefix: 'pmt', versioned: true, fields: [{ name: 'name', type: 'text' }, { name: 'template', type: 'code' }] },
  { slug: 'tools', prefix: 'tol', fields: [{ name: 'name', type: 'text' }, { name: 'function', type: 'relationship', relationTo: 'functions' }, { name: 'inputSchema', type: 'json' }] },
  { slug: 'memories', prefix: 'mem', fields: [{ name: 'key', type: 'text' }, { name: 'value', type: 'textarea' }, { name: 'agent', type: 'relationship', relationTo: 'agents' }, { name: 'scope', type: 'text' }] },
  { slug: 'agent-sessions', prefix: 'asn', fields: [{ name: 'agent', type: 'relationship', relationTo: 'agents' }, { name: 'status', type: 'text' }] },
  { slug: 'functions', prefix: 'fun', versioned: true, fields: [{ name: 'name', type: 'text' }, { name: 'slug', type: 'text' }] },
  { slug: 'workflows', prefix: 'wfl', versioned: true, fields: [{ name: 'name', type: 'text' }, { name: 'steps', type: 'array', fields: [{ name: 'function', type: 'relationship', relationTo: 'functions' }] }] },
  { slug: 'issues', prefix: 'iss', fields: [
    { name: 'title', type: 'text' }, { name: 'status', type: 'text' },
    { name: 'priority', type: 'text' }, { name: 'project', type: 'relationship', relationTo: 'projects' },
    { name: 'assignedAgent', type: 'relationship', relationTo: 'agents' },
    { name: 'parent', type: 'relationship', relationTo: 'issues' },
  ] },
  { slug: 'projects', prefix: 'prj', fields: [{ name: 'name', type: 'text' }, { name: 'status', type: 'text' }] },
  { slug: 'cost-events', prefix: 'cst', fields: [{ name: 'amount', type: 'number' }, { name: 'agent', type: 'relationship', relationTo: 'agents' }, { name: 'kind', type: 'text' }, { name: 'tokens', type: 'json' }] },
  { slug: 'users', prefix: 'usr', fields: [{ name: 'email', type: 'email' }, { name: 'name', type: 'text' }] },
  { slug: 'organizations', prefix: 'org', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'teams', prefix: 'tam', fields: [{ name: 'name', type: 'text' }, { name: 'lead', type: 'relationship', relationTo: 'users' }] },
  { slug: 'packages', prefix: 'pkg', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'modules', prefix: 'mod', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'components', prefix: 'cmp', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'goals', prefix: 'gol', fields: [{ name: 'title', type: 'text' }] },
  { slug: 'approvals', prefix: 'apr', fields: [{ name: 'title', type: 'text' }] },
  { slug: 'comments', prefix: 'cmn', fields: [{ name: 'body', type: 'textarea' }, { name: 'entity', type: 'number' }, { name: 'entityCollection', type: 'text' }] },
  { slug: 'roles', prefix: 'rol', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'api-keys', prefix: 'key', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'accounts', prefix: 'acc', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'integrations', prefix: 'int', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'connections', prefix: 'con', fields: [{ name: 'name', type: 'text' }, { name: 'integration', type: 'relationship', relationTo: 'integrations' }] },
  { slug: 'webhooks', prefix: 'whk', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'domains', prefix: 'dom', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'directories', prefix: 'dir', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'sources', prefix: 'src', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'resources', prefix: 'rsc', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'budget-policies', prefix: 'bgt', versioned: true, fields: [{ name: 'name', type: 'text' }, { name: 'limit', type: 'number' }] },
  { slug: 'media', prefix: 'med', fields: [{ name: 'alt', type: 'text' }] },
] as const

let adapter: DocumentAdapter
let pool: pg.Pool
let ns: string

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()
  adapter = new DocumentAdapter(
    { postgres: TEST_DB },
    COLLECTIONS.map(c => ({ slug: c.slug, prefix: c.prefix, fields: c.fields as any })),
  )
})

afterAll(async () => {
  await adapter.destroy()
  await teardownTestPool()
})

beforeEach(async () => {
  await cleanupTestData()
  ns = await createTestNs('phase2.test', 'Phase2')
  await adapter.nsResolver.refresh()
})

// ============================================================
// BEAD dax: Chat + Message CRUD with typed parts
// ============================================================
describe('Chat + Message CRUD', () => {
  it('creates chat and messages with typed parts', async () => {
    const user = await adapter.create({ ns, type: 'users', data: { email: 'test@test.com', name: 'Test' } })
    const userId = fromSqid(user.id).seq

    const chat = await adapter.create({
      ns,
      type: 'chats',
      data: { title: 'Test Chat', user: userId },
    })
    expect(chat.id).toMatch(/^cht_/)

    const chatId = fromSqid(chat.id).seq

    // User message with text part
    const msg1 = await adapter.create({
      ns,
      type: 'messages',
      data: {
        chat: chatId,
        role: 'user',
        parts: [{ type: 'text', text: 'Hello, search for AI news' }],
      },
    })
    expect(msg1.id).toMatch(/^msg_/)

    // Assistant message with text + tool-call + tool-result
    const msg2 = await adapter.create({
      ns,
      type: 'messages',
      data: {
        chat: chatId,
        role: 'assistant',
        parts: [
          { type: 'tool-call', toolCallId: 'tc_1', toolName: 'search', args: { query: 'AI news' } },
          { type: 'tool-result', toolCallId: 'tc_1', result: { results: ['article1', 'article2'] } },
          { type: 'text', text: 'Here are the latest AI news articles.' },
        ],
      },
    })

    // Find messages by chat
    const messages = await adapter.find({ ns, type: 'messages' })
    expect(messages.total).toBe(2)

    // Verify parts round-trip fidelity
    const found = await adapter.findOne({ ns, type: 'messages', id: msg2.id })
    const parts = found!.parts as Array<{ type: string }>
    expect(parts).toHaveLength(3)
    expect(parts[0].type).toBe('tool-call')
    expect(parts[1].type).toBe('tool-result')
    expect(parts[2].type).toBe('text')

    // Verify chat relationship
    expect(found!.chat).toBe(chat.id) // sqid
  })

  it('message with file and reasoning parts', async () => {
    const chat = await adapter.create({ ns, type: 'chats', data: { title: 'File Chat' } })
    const chatId = fromSqid(chat.id).seq

    const msg = await adapter.create({
      ns,
      type: 'messages',
      data: {
        chat: chatId,
        role: 'assistant',
        parts: [
          { type: 'reasoning', reasoning: 'Let me think about this...' },
          { type: 'text', text: 'Here is my analysis.' },
          { type: 'file', mimeType: 'image/png', data: 'base64data...' },
        ],
      },
    })

    const found = await adapter.findOne({ ns, type: 'messages', id: msg.id })
    const parts = found!.parts as Array<Record<string, unknown>>
    expect(parts[0].type).toBe('reasoning')
    expect(parts[0].reasoning).toBe('Let me think about this...')
    expect(parts[2].type).toBe('file')
  })
})

// ============================================================
// BEAD nya: Unified agent model with full relationship graph
// ============================================================
describe('Unified agent model', () => {
  it('creates agent with model, prompts, tools, sub-agents', async () => {
    const model = await adapter.create({ ns, type: 'models', data: { name: 'Claude 4', modelId: 'claude-sonnet-4-6', provider: 'anthropic' } })
    const prompt = await adapter.create({ ns, type: 'prompts', data: { name: 'System', template: 'You are helpful.' } })
    const fn = await adapter.create({ ns, type: 'functions', data: { name: 'search', slug: 'search' } })
    const tool = await adapter.create({ ns, type: 'tools', data: { name: 'Web Search', function: fromSqid(fn.id).seq, inputSchema: { type: 'object' } } })

    // Create sub-agent first
    const subAgent = await adapter.create({
      ns,
      type: 'agents',
      data: { name: 'Research Sub', slug: 'research-sub' },
    })

    const agent = await adapter.create({
      ns,
      type: 'agents',
      data: {
        name: 'Research Agent',
        slug: 'research',
        model: fromSqid(model.id).seq,
        prompts: [fromSqid(prompt.id).seq],
        tools: [fromSqid(tool.id).seq],
        subAgents: [fromSqid(subAgent.id).seq],
        config: { temperature: 0.7, maxTokens: 4096 },
        permissions: { allow: ['read.*', 'write.code'], deny: ['write.finance'] },
      },
    })

    expect(agent.id).toMatch(/^agt_/)

    // Verify full relationship graph
    const found = await adapter.findOne({ ns, type: 'agents', id: agent.id })
    expect(found!.model).toBe(model.id)
    expect((found!.prompts as string[])[0]).toBe(prompt.id)
    expect((found!.tools as string[])[0]).toBe(tool.id)
    expect((found!.subAgents as string[])[0]).toBe(subAgent.id)
    expect((found!.config as Record<string, unknown>).temperature).toBe(0.7)
    expect((found!.permissions as Record<string, unknown>).deny).toContain('write.finance')

    // Verify rels table
    const rels = await query<{ path: string }>(
      pool,
      `SELECT path FROM rels WHERE "from" = $1 ORDER BY path`,
      [fromSqid(agent.id).seq],
    )
    expect(rels.rows.map(r => r.path)).toEqual(['model', 'prompts.0', 'subAgents.0', 'tools.0'])
  })
})

// ============================================================
// BEAD 3dz: Agent-runs via actions table facade
// ============================================================
describe('Agent-runs lifecycle', () => {
  it('full agent-run lifecycle: create → dequeue → checkpoint → complete', async () => {
    const agent = await adapter.create({ ns, type: 'agents', data: { name: 'Test Agent', slug: 'test' } })

    const run = await adapter.create({
      ns,
      type: 'agent-runs',
      data: {
        type: 'agent-run',
        name: 'execute-task',
        input: { agentId: fromSqid(agent.id).seq, task: 'Search for news' },
      },
    })
    expect(run.id).toMatch(/^arn_/)

    // Find all runs
    const allRuns = await adapter.find({ ns, type: 'agent-runs' })
    expect(allRuns.total).toBe(1)

    // Dequeue
    const dequeued = await adapter.dequeue({ ns, type: 'agent-run', limit: 1 })
    expect(dequeued).toHaveLength(1)
    expect(dequeued[0].name).toBe('execute-task')

    // Checkpoint
    await adapter.checkpoint({ id: run.id, step: 1, result: { tool: 'search', output: ['result1'] } })
    await adapter.checkpoint({ id: run.id, step: 2, result: { tool: 'summarize', output: 'Summary' } })

    // Complete
    await adapter.complete({ id: run.id, output: { answer: 'Here are the news items.' } })

    const intId = fromSqid(run.id).seq
    const final = await query<{ status: string; steps: unknown[]; output: Record<string, unknown> }>(
      pool,
      `SELECT status, steps, output FROM actions WHERE seq = $1`,
      [intId],
    )
    expect(final.rows[0].status).toBe('completed')
    expect(final.rows[0].steps).toHaveLength(2)
    expect(final.rows[0].output.answer).toBe('Here are the news items.')
  })

  it('sub-agent run hierarchy via parent', async () => {
    const parentRun = await adapter.create({
      ns,
      type: 'agent-runs',
      data: { type: 'agent-run', name: 'parent-run' },
    })

    // Create child run referencing parent (via enqueue with parent)
    const childId = await adapter.enqueue({
      ns,
      type: 'agent-run',
      name: 'child-run',
      input: { parentRunId: fromSqid(parentRun.id).seq },
    })

    expect(childId).toMatch(/^act_/)
  })
})

// ============================================================
// BEAD 9ba: Issues + Projects collections
// ============================================================
describe('Issues + Projects', () => {
  it('creates project and issues with relationships', async () => {
    const project = await adapter.create({
      ns,
      type: 'projects',
      data: { name: 'Platform v2', status: 'active' },
    })
    expect(project.id).toMatch(/^prj_/)

    const projectId = fromSqid(project.id).seq

    const issue1 = await adapter.create({
      ns,
      type: 'issues',
      data: { title: 'Fix login bug', status: 'todo', priority: 'high', project: projectId },
    })
    const issue2 = await adapter.create({
      ns,
      type: 'issues',
      data: { title: 'Add search', status: 'backlog', priority: 'medium', project: projectId },
    })
    const issue3 = await adapter.create({
      ns,
      type: 'issues',
      data: { title: 'Refactor auth', status: 'in-progress', priority: 'medium', project: projectId },
    })

    // Find all issues
    const all = await adapter.find({ ns, type: 'issues' })
    expect(all.total).toBe(3)

    // Filter by status
    const todos = await adapter.find({
      ns,
      type: 'issues',
      where: { status: { equals: 'todo' } },
    })
    expect(todos.total).toBe(1)
    expect(todos.docs[0].title).toBe('Fix login bug')

    // Verify project relationship
    const found = await adapter.findOne({ ns, type: 'issues', id: issue1.id })
    expect(found!.project).toBe(project.id)
  })

  it('sub-issues via parent self-ref', async () => {
    const epic = await adapter.create({
      ns,
      type: 'issues',
      data: { title: 'Epic: Auth Overhaul', status: 'todo' },
    })

    const sub1 = await adapter.create({
      ns,
      type: 'issues',
      data: { title: 'Add OAuth', status: 'todo', parent: fromSqid(epic.id).seq },
    })

    const found = await adapter.findOne({ ns, type: 'issues', id: sub1.id })
    expect(found!.parent).toBe(epic.id)
  })
})

// ============================================================
// BEAD ipk: Cost events collection
// ============================================================
describe('Cost events', () => {
  it('creating a cost event stores in data table', async () => {
    const agent = await adapter.create({ ns, type: 'agents', data: { name: 'Cost Agent', slug: 'cost' } })
    const agentId = fromSqid(agent.id).seq

    const cost = await adapter.create({
      ns,
      type: 'cost-events',
      data: {
        type: 'llm-inference',
        amount: 150, // microdollars
        agent: agentId,
        tokens: { input: 1000, output: 500 },
      },
    })
    expect(cost.id).toMatch(/^cst_/)

    // Verify cost event was created in data table
    const found = await adapter.findOne({ ns, type: 'cost-events', id: cost.id })
    expect(found).not.toBeNull()
    expect(found!.amount).toBe(150)
  })

  it('cost events can be aggregated by agent', async () => {
    const a1 = await adapter.create({ ns, type: 'agents', data: { name: 'Agent A', slug: 'a' } })
    const a2 = await adapter.create({ ns, type: 'agents', data: { name: 'Agent B', slug: 'b' } })
    const a1Id = fromSqid(a1.id).seq
    const a2Id = fromSqid(a2.id).seq

    // Agent A: 3 cost events
    for (let i = 0; i < 3; i++) {
      await adapter.create({ ns, type: 'cost-events', data: { type: 'llm', amount: 100, agent: a1Id } })
    }
    // Agent B: 1 cost event
    await adapter.create({ ns, type: 'cost-events', data: { type: 'llm', amount: 200, agent: a2Id } })

    const allCosts = await adapter.find({ ns, type: 'cost-events' })
    expect(allCosts.total).toBe(4)
  })
})

// ============================================================
// BEAD 6gu: Dynamic collection registration at boot
// ============================================================
describe('Dynamic collection registration at boot', () => {
  it('loads nouns and registers as dynamic collections', async () => {
    // Seed a noun with schema
    await adapter.create({
      ns,
      type: 'nouns',
      data: {
        name: 'Contact',
        slug: 'contact',
        plural: 'Contacts',
        schema: {
          fields: [
            { name: 'firstName', type: 'text', required: true },
            { name: 'lastName', type: 'text' },
            { name: 'email', type: 'email' },
          ],
        },
      },
    })

    // Load dynamic collections
    await adapter.loadDynamicCollections(ns)

    // The 'contact' collection should now be available
    const contact = await adapter.create({
      ns,
      type: 'contact',
      data: { firstName: 'John', lastName: 'Doe', email: 'john@example.com' },
    })

    // Dynamic collections get a derived prefix
    expect(contact.id.length).toBeGreaterThan(4)

    const found = await adapter.findOne({ ns, type: 'contact', id: contact.id })
    expect(found!.firstName).toBe('John')
  })

  it('handles multiple dynamic collections', async () => {
    await adapter.create({
      ns,
      type: 'nouns',
      data: {
        name: 'Invoice',
        slug: 'invoice',
        schema: { fields: [{ name: 'total', type: 'number' }, { name: 'status', type: 'text' }] },
      },
    })
    await adapter.create({
      ns,
      type: 'nouns',
      data: {
        name: 'Product',
        slug: 'product',
        schema: { fields: [{ name: 'sku', type: 'text' }, { name: 'price', type: 'number' }] },
      },
    })

    await adapter.loadDynamicCollections(ns)

    const inv = await adapter.create({ ns, type: 'invoice', data: { total: 9999, status: 'pending' } })
    const prod = await adapter.create({ ns, type: 'product', data: { sku: 'ABC-123', price: 2500 } })

    expect(inv.id.length).toBeGreaterThan(4)
    expect(prod.id.length).toBeGreaterThan(4)

    // Each collection is isolated
    const invoices = await adapter.find({ ns, type: 'invoice' })
    expect(invoices.total).toBe(1)
    const products = await adapter.find({ ns, type: 'product' })
    expect(products.total).toBe(1)
  })
})
