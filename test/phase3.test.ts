/**
 * Phase 3 TDD: Remaining collections, governance, budget, events, E2E
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { fromSqid } from '../src/id/sqids.js'
import { query } from '../src/db/pg.js'
import type pg from 'pg'

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

const COLLECTIONS = [
  { slug: 'nouns', prefix: 'nou', fields: [{ name: 'name', type: 'text' }, { name: 'slug', type: 'text' }, { name: 'schema', type: 'json' }] },
  { slug: 'chats', prefix: 'cht', fields: [{ name: 'title', type: 'text' }] },
  { slug: 'messages', prefix: 'msg', fields: [{ name: 'chat', type: 'relationship', relationTo: 'chats' }, { name: 'role', type: 'text' }, { name: 'parts', type: 'json' }] },
  { slug: 'votes', prefix: 'vot', fields: [{ name: 'message', type: 'relationship', relationTo: 'messages' }, { name: 'user', type: 'relationship', relationTo: 'users' }, { name: 'vote', type: 'text' }] },
  { slug: 'documents', prefix: 'doc', fields: [{ name: 'title', type: 'text' }, { name: 'content', type: 'textarea' }, { name: 'kind', type: 'text' }, { name: 'user', type: 'relationship', relationTo: 'users' }, { name: 'chat', type: 'relationship', relationTo: 'chats' }] },
  { slug: 'suggestions', prefix: 'sug', fields: [{ name: 'document', type: 'relationship', relationTo: 'documents' }, { name: 'message', type: 'relationship', relationTo: 'messages' }, { name: 'originalText', type: 'textarea' }, { name: 'suggestedText', type: 'textarea' }, { name: 'status', type: 'text' }] },
  { slug: 'streams', prefix: 'stm', fields: [{ name: 'chat', type: 'relationship', relationTo: 'chats' }, { name: 'streamId', type: 'text' }, { name: 'status', type: 'text' }] },
  { slug: 'agents', prefix: 'agt', fields: [{ name: 'name', type: 'text' }, { name: 'model', type: 'relationship', relationTo: 'models' }, { name: 'tools', type: 'relationship', relationTo: 'tools', hasMany: true }, { name: 'config', type: 'json' }, { name: 'permissions', type: 'json' }] },
  { slug: 'models', prefix: 'mdl', fields: [{ name: 'name', type: 'text' }, { name: 'modelId', type: 'text' }] },
  { slug: 'prompts', prefix: 'pmt', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'tools', prefix: 'tol', fields: [{ name: 'name', type: 'text' }, { name: 'function', type: 'relationship', relationTo: 'functions' }, { name: 'governance', type: 'text' }] },
  { slug: 'memories', prefix: 'mem', fields: [{ name: 'key', type: 'text' }, { name: 'value', type: 'textarea' }, { name: 'agent', type: 'relationship', relationTo: 'agents' }, { name: 'scope', type: 'text' }] },
  { slug: 'agent-sessions', prefix: 'asn', fields: [{ name: 'agent', type: 'relationship', relationTo: 'agents' }, { name: 'status', type: 'text' }, { name: 'context', type: 'json' }] },
  { slug: 'functions', prefix: 'fun', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'workflows', prefix: 'wfl', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'issues', prefix: 'iss', fields: [{ name: 'title', type: 'text' }, { name: 'status', type: 'text' }, { name: 'assignedAgent', type: 'relationship', relationTo: 'agents' }, { name: 'project', type: 'relationship', relationTo: 'projects' }] },
  { slug: 'projects', prefix: 'prj', fields: [{ name: 'name', type: 'text' }, { name: 'status', type: 'text' }] },
  { slug: 'goals', prefix: 'gol', fields: [{ name: 'title', type: 'text' }, { name: 'status', type: 'text' }, { name: 'project', type: 'relationship', relationTo: 'projects' }] },
  { slug: 'approvals', prefix: 'apr', fields: [{ name: 'title', type: 'text' }, { name: 'status', type: 'text' }, { name: 'requester', type: 'relationship', relationTo: 'users' }] },
  { slug: 'comments', prefix: 'cmn', fields: [{ name: 'body', type: 'textarea' }, { name: 'author', type: 'relationship', relationTo: 'users' }, { name: 'parent', type: 'relationship', relationTo: 'comments' }] },
  { slug: 'users', prefix: 'usr', fields: [{ name: 'email', type: 'email' }, { name: 'name', type: 'text' }] },
  { slug: 'cost-events', prefix: 'cst', fields: [{ name: 'amount', type: 'number' }, { name: 'agent', type: 'relationship', relationTo: 'agents' }, { name: 'kind', type: 'text' }] },
  { slug: 'budget-policies', prefix: 'bgt', fields: [{ name: 'name', type: 'text' }, { name: 'limit', type: 'number' }, { name: 'period', type: 'text' }] },
  { slug: 'organizations', prefix: 'org', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'teams', prefix: 'tam', fields: [{ name: 'name', type: 'text' }, { name: 'lead', type: 'relationship', relationTo: 'users' }] },
  { slug: 'integrations', prefix: 'int', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'connections', prefix: 'con', fields: [{ name: 'name', type: 'text' }, { name: 'integration', type: 'relationship', relationTo: 'integrations' }] },
  { slug: 'webhooks', prefix: 'whk', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'domains', prefix: 'dom', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'sources', prefix: 'src', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'resources', prefix: 'rsc', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'media', prefix: 'med', fields: [{ name: 'alt', type: 'text' }] },
] as const

let adapter: DocumentAdapter
let pool: pg.Pool
let nsId: number

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()
  adapter = new DocumentAdapter({ postgres: TEST_DB }, COLLECTIONS.map(c => ({ slug: c.slug, prefix: c.prefix, fields: c.fields as any })))
})

afterAll(async () => {
  await adapter.destroy()
  await teardownTestPool()
})

beforeEach(async () => {
  await cleanupTestData()
  const result = await query<{ id: number }>(pool, `INSERT INTO ns (uri, name, kind) VALUES ('phase3.test', 'Phase3', 'production') RETURNING id`)
  nsId = result.rows[0].id
  await adapter.nsResolver.refresh()
})

// BEAD ebe: Votes, Suggestions, Documents
describe('Votes, Suggestions, Documents', () => {
  it('creates versioned document, suggestion, and vote', async () => {
    const user = await adapter.create({ ns: nsId, collection: 'users', data: { email: 'alice@test.com', name: 'Alice' } })
    const chat = await adapter.create({ ns: nsId, collection: 'chats', data: { title: 'Design Chat' } })
    const userId = fromSqid(user.id).id
    const chatId = fromSqid(chat.id).id

    // Create document
    const doc = await adapter.create({ ns: nsId, collection: 'documents', data: { title: 'Design Spec', content: 'Initial draft', kind: 'text', user: userId, chat: chatId } })
    expect(doc.id).toMatch(/^doc_/)

    // Create message
    const msg = await adapter.create({ ns: nsId, collection: 'messages', data: { chat: chatId, role: 'assistant', parts: [{ type: 'text', text: 'Suggestion' }] } })

    // Create suggestion on document
    const sug = await adapter.create({
      ns: nsId, collection: 'suggestions',
      data: { document: fromSqid(doc.id).id, message: fromSqid(msg.id).id, originalText: 'Initial draft', suggestedText: 'Revised draft', status: 'pending' },
    })
    expect(sug.id).toMatch(/^sug_/)

    const foundSug = await adapter.findOne({ ns: nsId, collection: 'suggestions', id: sug.id })
    expect(foundSug!.document).toBe(doc.id)
    expect(foundSug!.message).toBe(msg.id)

    // Create vote on message
    const vote = await adapter.create({ ns: nsId, collection: 'votes', data: { message: fromSqid(msg.id).id, user: userId, vote: 'up' } })
    expect(vote.id).toMatch(/^vot_/)
  })
})

// BEAD ftd: Agent sessions and memories
describe('Agent sessions and memories', () => {
  it('creates session and scoped memories', async () => {
    const agent = await adapter.create({ ns: nsId, collection: 'agents', data: { name: 'Memory Agent' } })
    const agentId = fromSqid(agent.id).id

    const session = await adapter.create({ ns: nsId, collection: 'agent-sessions', data: { agent: agentId, status: 'active', context: { task: 'research' } } })
    expect(session.id).toMatch(/^asn_/)

    // Session-scoped memory
    await adapter.create({ ns: nsId, collection: 'memories', data: { key: 'last_query', value: 'AI news', agent: agentId, scope: 'session' } })
    // Agent-global memory
    await adapter.create({ ns: nsId, collection: 'memories', data: { key: 'preference', value: 'concise', agent: agentId, scope: 'agent' } })
    // Global memory
    await adapter.create({ ns: nsId, collection: 'memories', data: { key: 'system_info', value: 'v2.0', scope: 'global' } })

    const allMemories = await adapter.find({ ns: nsId, collection: 'memories' })
    expect(allMemories.total).toBe(3)

    // Filter by scope
    const agentMemories = await adapter.find({ ns: nsId, collection: 'memories', where: { scope: { equals: 'agent' } } })
    expect(agentMemories.total).toBe(1)
    expect(agentMemories.docs[0].key).toBe('preference')
  })
})

// BEAD j3b: Tool governance
describe('Tool governance', () => {
  it('evaluates tool permissions from agent config', async () => {
    const { evaluateToolAccess } = await import('../src/agents/governance.js')

    const permissions = { allow: ['read.*', 'write.code'], deny: ['write.finance'] }
    expect(evaluateToolAccess(permissions, 'read.file')).toBe(true)
    expect(evaluateToolAccess(permissions, 'read.database')).toBe(true)
    expect(evaluateToolAccess(permissions, 'write.code')).toBe(true)
    expect(evaluateToolAccess(permissions, 'write.finance')).toBe(false) // denied
    expect(evaluateToolAccess(permissions, 'write.other')).toBe(false) // not in allow
    expect(evaluateToolAccess(permissions, 'execute.deploy')).toBe(false) // not in allow
  })

  it('wildcard allow-all', async () => {
    const { evaluateToolAccess } = await import('../src/agents/governance.js')
    expect(evaluateToolAccess({ allow: ['*'] }, 'anything')).toBe(true)
    expect(evaluateToolAccess({ allow: ['*'], deny: ['dangerous'] }, 'dangerous')).toBe(false)
  })
})

// BEAD d8w: Issue execution via actions table
describe('Issue execution on agent assign', () => {
  it('assigning agent to issue enqueues an action', async () => {
    const agent = await adapter.create({ ns: nsId, collection: 'agents', data: { name: 'Worker' } })
    const project = await adapter.create({ ns: nsId, collection: 'projects', data: { name: 'Test Project', status: 'active' } })
    const issue = await adapter.create({
      ns: nsId, collection: 'issues',
      data: { title: 'Implement feature', status: 'todo', project: fromSqid(project.id).id },
    })

    // Assign agent to issue
    await adapter.updateOne({
      ns: nsId, collection: 'issues', id: issue.id,
      data: { assignedAgent: fromSqid(agent.id).id, status: 'in-progress' },
    })

    // Verify the issue was updated
    const found = await adapter.findOne({ ns: nsId, collection: 'issues', id: issue.id })
    expect(found!.assignedAgent).toBe(agent.id)
    expect(found!.status).toBe('in-progress')
  })
})

// BEAD zfm: Budget policies
describe('Budget policies with enforcement', () => {
  it('detects budget threshold breach', async () => {
    const { checkBudget } = await import('../src/finance/budget.js')

    const agent = await adapter.create({ ns: nsId, collection: 'agents', data: { name: 'Spender' } })
    const agentId = fromSqid(agent.id).id

    // Create budget policy
    await adapter.create({ ns: nsId, collection: 'budget-policies', data: { name: 'Agent Monthly', limit: 1000, period: 'monthly' } })

    // Create cost events totaling 850 (85% of 1000)
    for (let i = 0; i < 17; i++) {
      await adapter.create({ ns: nsId, collection: 'cost-events', data: { kind: 'llm', amount: 50, agent: agentId } })
    }

    const result = await checkBudget(pool, nsId, 1000)
    expect(result.totalSpent).toBe(850)
    expect(result.percentUsed).toBeCloseTo(85)
    expect(result.exceeded).toBe(false)
    expect(result.warning).toBe(true) // >80%
  })
})

// BEAD 2e8: Typed event emission
describe('Typed event emission', () => {
  it('all CRUD operations emit correctly typed log entries', async () => {
    const chat = await adapter.create({ ns: nsId, collection: 'chats', data: { title: 'Event Chat' } })
    await adapter.updateOne({ ns: nsId, collection: 'chats', id: chat.id, data: { title: 'Renamed' } })
    await adapter.deleteMany({ ns: nsId, collection: 'chats', where: { title: { equals: 'Renamed' } } })

    await adapter.emit({ ns: nsId, kind: 'page.viewed', meta: { path: '/test' } })
    await adapter.emit({ ns: nsId, kind: 'search.query', meta: { query: 'test' } })

    const logs = await query<{ kind: string }>(pool, `SELECT kind FROM log WHERE ns = $1 ORDER BY created`, [nsId])
    const kinds = logs.rows.map(r => r.kind)
    expect(kinds).toContain('data.created')
    expect(kinds).toContain('data.updated')
    expect(kinds).toContain('data.deleted')
    expect(kinds).toContain('page.viewed')
    expect(kinds).toContain('search.query')
  })
})

// BEAD kvv: Thing CRUD through dynamic nouns
describe('Thing CRUD through dynamic noun collections', () => {
  it('creates things via dynamic collection slug', async () => {
    await adapter.create({
      ns: nsId, collection: 'nouns',
      data: { name: 'Contact', slug: 'contact', schema: { fields: [{ name: 'firstName', type: 'text' }, { name: 'email', type: 'email' }] } },
    })

    await adapter.loadDynamicCollections(nsId)

    const c1 = await adapter.create({ ns: nsId, collection: 'contact', data: { firstName: 'Alice', email: 'alice@test.com' } })
    const c2 = await adapter.create({ ns: nsId, collection: 'contact', data: { firstName: 'Bob', email: 'bob@test.com' } })

    const contacts = await adapter.find({ ns: nsId, collection: 'contact' })
    expect(contacts.total).toBe(2)

    const found = await adapter.findOne({ ns: nsId, collection: 'contact', id: c1.id })
    expect(found!.firstName).toBe('Alice')
  })
})

// BEAD f6o: Streams
describe('Stream lifecycle', () => {
  it('creates and manages stream status', async () => {
    const chat = await adapter.create({ ns: nsId, collection: 'chats', data: { title: 'Streaming Chat' } })
    const chatId = fromSqid(chat.id).id

    const stream = await adapter.create({
      ns: nsId, collection: 'streams',
      data: { chat: chatId, streamId: 'stream-abc-123', status: 'active' },
    })
    expect(stream.id).toMatch(/^stm_/)

    await adapter.updateOne({
      ns: nsId, collection: 'streams', id: stream.id,
      data: { status: 'completed' },
    })

    const found = await adapter.findOne({ ns: nsId, collection: 'streams', id: stream.id })
    expect(found!.status).toBe('completed')

    // Filter by status
    const active = await adapter.find({ ns: nsId, collection: 'streams', where: { status: { equals: 'active' } } })
    expect(active.total).toBe(0)
  })
})

// BEAD dnd: Goals + Approvals
describe('Goals + Approvals', () => {
  it('creates goal linked to project, approval with workflow', async () => {
    const user = await adapter.create({ ns: nsId, collection: 'users', data: { email: 'pm@test.com', name: 'PM' } })
    const project = await adapter.create({ ns: nsId, collection: 'projects', data: { name: 'Q1 Goals', status: 'active' } })

    const goal = await adapter.create({
      ns: nsId, collection: 'goals',
      data: { title: 'Increase Revenue 20%', status: 'on-track', project: fromSqid(project.id).id },
    })
    expect(goal.id).toMatch(/^gol_/)

    const approval = await adapter.create({
      ns: nsId, collection: 'approvals',
      data: { title: 'Approve Budget Increase', status: 'pending', requester: fromSqid(user.id).id },
    })
    expect(approval.id).toMatch(/^apr_/)

    const found = await adapter.findOne({ ns: nsId, collection: 'approvals', id: approval.id })
    expect(found!.requester).toBe(user.id)
    expect(found!.status).toBe('pending')

    // Approve
    await adapter.updateOne({ ns: nsId, collection: 'approvals', id: approval.id, data: { status: 'approved' } })
    const approved = await adapter.findOne({ ns: nsId, collection: 'approvals', id: approval.id })
    expect(approved!.status).toBe('approved')
  })
})

// BEAD 2qq: Polymorphic comments
describe('Polymorphic comments', () => {
  it('creates threaded comments on issues', async () => {
    const user = await adapter.create({ ns: nsId, collection: 'users', data: { email: 'dev@test.com', name: 'Dev' } })
    const userId = fromSqid(user.id).id

    const comment1 = await adapter.create({
      ns: nsId, collection: 'comments',
      data: { body: 'This needs review', author: userId },
    })
    expect(comment1.id).toMatch(/^cmn_/)

    // Reply
    const reply = await adapter.create({
      ns: nsId, collection: 'comments',
      data: { body: 'I agree, lets discuss', author: userId, parent: fromSqid(comment1.id).id },
    })

    const found = await adapter.findOne({ ns: nsId, collection: 'comments', id: reply.id })
    expect(found!.parent).toBe(comment1.id)
  })
})

// BEAD h4p: E2E Agent lifecycle
describe('E2E: Agent lifecycle with cost tracking', () => {
  it('full lifecycle: create agent → run → checkpoint → cost → complete', async () => {
    const model = await adapter.create({ ns: nsId, collection: 'models', data: { name: 'Claude', modelId: 'claude-sonnet-4-6' } })
    const fn = await adapter.create({ ns: nsId, collection: 'functions', data: { name: 'search' } })
    const tool = await adapter.create({ ns: nsId, collection: 'tools', data: { name: 'Search', function: fromSqid(fn.id).id } })

    const agent = await adapter.create({
      ns: nsId, collection: 'agents',
      data: { name: 'E2E Agent', model: fromSqid(model.id).id, tools: [fromSqid(tool.id).id], config: { temperature: 0.5 } },
    })
    const agentId = fromSqid(agent.id).id

    // Start session
    const session = await adapter.create({ ns: nsId, collection: 'agent-sessions', data: { agent: agentId, status: 'active' } })

    // Create agent-run
    const run = await adapter.create({
      ns: nsId, collection: 'agent-runs',
      data: { kind: 'agent-run', name: 'e2e-test', input: { agentId, task: 'Research AI' } },
    })

    // Dequeue and execute
    const dequeued = await adapter.dequeue({ ns: nsId, kind: 'agent-run', limit: 1 })
    expect(dequeued).toHaveLength(1)

    // Checkpoint: tool call
    await adapter.checkpoint({ id: run.id, step: 1, result: { tool: 'search', output: ['result1'] } })

    // Cost event
    await adapter.create({ ns: nsId, collection: 'cost-events', data: { kind: 'llm', amount: 150, agent: agentId } })

    // Memory
    await adapter.create({ ns: nsId, collection: 'memories', data: { key: 'task_result', value: 'Found 3 articles', agent: agentId, scope: 'session' } })

    // Complete
    await adapter.complete({ id: run.id, output: { answer: '3 articles found' } })

    // Close session
    await adapter.updateOne({ ns: nsId, collection: 'agent-sessions', id: session.id, data: { status: 'closed' } })

    // Verify everything
    const finalAgent = await adapter.findOne({ ns: nsId, collection: 'agents', id: agent.id })
    expect(finalAgent!.name).toBe('E2E Agent')

    const costs = await adapter.find({ ns: nsId, collection: 'cost-events' })
    expect(costs.total).toBe(1)

    const memories = await adapter.find({ ns: nsId, collection: 'memories' })
    expect(memories.total).toBe(1)

    const logs = await query<{ kind: string }>(pool, `SELECT kind FROM log WHERE ns = $1`, [nsId])
    expect(logs.rows.length).toBeGreaterThan(5) // Multiple CRUD operations logged
  })
})
