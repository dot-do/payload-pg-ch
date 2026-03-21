/**
 * Phase 4: Final E2E tests - Chat workflow, Paperclip company workflow, COW with new collections
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { fromSqid } from '../src/id/sqids.js'
import { query } from '../src/db/pg.js'
import type pg from 'pg'

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

const COLLECTIONS = [
  { slug: 'chats', prefix: 'cht', fields: [{ name: 'title', type: 'text' }, { name: 'user', type: 'relationship', relationTo: 'users' }] },
  { slug: 'messages', prefix: 'msg', fields: [{ name: 'chat', type: 'relationship', relationTo: 'chats' }, { name: 'role', type: 'text' }, { name: 'parts', type: 'json' }] },
  { slug: 'votes', prefix: 'vot', fields: [{ name: 'message', type: 'relationship', relationTo: 'messages' }, { name: 'vote', type: 'text' }] },
  { slug: 'documents', prefix: 'doc', fields: [{ name: 'title', type: 'text' }, { name: 'content', type: 'textarea' }, { name: 'chat', type: 'relationship', relationTo: 'chats' }] },
  { slug: 'suggestions', prefix: 'sug', fields: [{ name: 'document', type: 'relationship', relationTo: 'documents' }, { name: 'originalText', type: 'textarea' }, { name: 'suggestedText', type: 'textarea' }] },
  { slug: 'agents', prefix: 'agt', fields: [{ name: 'name', type: 'text' }, { name: 'model', type: 'relationship', relationTo: 'models' }, { name: 'tools', type: 'relationship', relationTo: 'tools', hasMany: true }, { name: 'config', type: 'json' }] },
  { slug: 'models', prefix: 'mdl', fields: [{ name: 'name', type: 'text' }, { name: 'modelId', type: 'text' }] },
  { slug: 'tools', prefix: 'tol', fields: [{ name: 'name', type: 'text' }, { name: 'function', type: 'relationship', relationTo: 'functions' }] },
  { slug: 'functions', prefix: 'fun', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'issues', prefix: 'iss', fields: [{ name: 'title', type: 'text' }, { name: 'status', type: 'text' }, { name: 'assignedAgent', type: 'relationship', relationTo: 'agents' }, { name: 'project', type: 'relationship', relationTo: 'projects' }] },
  { slug: 'projects', prefix: 'prj', fields: [{ name: 'name', type: 'text' }, { name: 'status', type: 'text' }] },
  { slug: 'goals', prefix: 'gol', fields: [{ name: 'title', type: 'text' }, { name: 'project', type: 'relationship', relationTo: 'projects' }] },
  { slug: 'approvals', prefix: 'apr', fields: [{ name: 'title', type: 'text' }, { name: 'status', type: 'text' }] },
  { slug: 'cost-events', prefix: 'cst', fields: [{ name: 'amount', type: 'number' }, { name: 'agent', type: 'relationship', relationTo: 'agents' }, { name: 'kind', type: 'text' }] },
  { slug: 'budget-policies', prefix: 'bgt', fields: [{ name: 'name', type: 'text' }, { name: 'limit', type: 'number' }] },
  { slug: 'users', prefix: 'usr', fields: [{ name: 'email', type: 'email' }, { name: 'name', type: 'text' }] },
  { slug: 'organizations', prefix: 'org', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'memories', prefix: 'mem', fields: [{ name: 'key', type: 'text' }, { name: 'value', type: 'textarea' }, { name: 'agent', type: 'relationship', relationTo: 'agents' }] },
  { slug: 'comments', prefix: 'cmn', fields: [{ name: 'body', type: 'textarea' }] },
] as const

let adapter: DocumentAdapter
let pool: pg.Pool

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
})

// BEAD e28: E2E Full chat workflow
describe('E2E: Full chat workflow', () => {
  it('user → chat → messages → vote → document → suggestion', async () => {
    const nsResult = await query<{ id: number }>(pool, `INSERT INTO ns (uri, name, kind) VALUES ('chat-e2e.test', 'ChatE2E', 'production') RETURNING id`)
    const nsId = nsResult.rows[0].id
    await adapter.nsResolver.refresh()

    // 1. Create user
    const user = await adapter.create({ ns: nsId, collection: 'users', data: { email: 'alice@chat.test', name: 'Alice' } })

    // 2. Create chat
    const chat = await adapter.create({ ns: nsId, collection: 'chats', data: { title: 'AI Research', user: fromSqid(user.id).id } })

    // 3. Send user message
    const userMsg = await adapter.create({
      ns: nsId, collection: 'messages',
      data: { chat: fromSqid(chat.id).id, role: 'user', parts: [{ type: 'text', text: 'Tell me about transformers' }] },
    })

    // 4. AI response with tool call
    const assistantMsg = await adapter.create({
      ns: nsId, collection: 'messages',
      data: {
        chat: fromSqid(chat.id).id, role: 'assistant',
        parts: [
          { type: 'tool-call', toolCallId: 'tc_1', toolName: 'search', args: { q: 'transformers architecture' } },
          { type: 'tool-result', toolCallId: 'tc_1', result: { articles: ['Attention Is All You Need'] } },
          { type: 'text', text: 'Transformers were introduced in the 2017 paper "Attention Is All You Need"...' },
        ],
      },
    })

    // 5. Vote on response
    await adapter.create({ ns: nsId, collection: 'votes', data: { message: fromSqid(assistantMsg.id).id, vote: 'up' } })

    // 6. Create document from chat
    const doc = await adapter.create({
      ns: nsId, collection: 'documents',
      data: { title: 'Transformer Notes', content: 'Based on the chat discussion...', chat: fromSqid(chat.id).id },
    })

    // 7. Add suggestion to document
    await adapter.create({
      ns: nsId, collection: 'suggestions',
      data: { document: fromSqid(doc.id).id, originalText: 'Based on', suggestedText: 'Drawing from' },
    })

    // Verify full chain
    const messages = await adapter.find({ ns: nsId, collection: 'messages' })
    expect(messages.total).toBe(2)

    const chatDoc = await adapter.findOne({ ns: nsId, collection: 'chats', id: chat.id })
    expect(chatDoc!.user).toBe(user.id)

    const docFound = await adapter.findOne({ ns: nsId, collection: 'documents', id: doc.id })
    expect(docFound!.chat).toBe(chat.id)

  })
})

// BEAD gs1: E2E Paperclip company workflow
describe('E2E: Paperclip company workflow', () => {
  it('org → project → issues → agent → runs → costs → approval', async () => {
    const nsResult = await query<{ id: number }>(pool, `INSERT INTO ns (uri, name, kind) VALUES ('paperclip-e2e.test', 'PaperclipE2E', 'production') RETURNING id`)
    const nsId = nsResult.rows[0].id
    await adapter.nsResolver.refresh()

    // 1. Create company (org)
    const org = await adapter.create({ ns: nsId, collection: 'organizations', data: { name: 'Acme AI Corp' } })

    // 2. Create project
    const project = await adapter.create({ ns: nsId, collection: 'projects', data: { name: 'Platform v2', status: 'active' } })

    // 3. Create goal
    const goal = await adapter.create({ ns: nsId, collection: 'goals', data: { title: 'Ship v2 by Q2', project: fromSqid(project.id).id } })

    // 4. Create agent
    const model = await adapter.create({ ns: nsId, collection: 'models', data: { name: 'Claude', modelId: 'claude-sonnet-4-6' } })
    const agent = await adapter.create({
      ns: nsId, collection: 'agents',
      data: { name: 'Dev Agent', model: fromSqid(model.id).id, config: { maxConcurrency: 1 } },
    })

    // 5. Create issues and assign agent
    const issue1 = await adapter.create({
      ns: nsId, collection: 'issues',
      data: { title: 'Implement auth', status: 'todo', project: fromSqid(project.id).id, assignedAgent: fromSqid(agent.id).id },
    })
    const issue2 = await adapter.create({
      ns: nsId, collection: 'issues',
      data: { title: 'Add API docs', status: 'backlog', project: fromSqid(project.id).id },
    })

    // 6. Agent runs
    const run = await adapter.create({
      ns: nsId, collection: 'agent-runs',
      data: { kind: 'agent-run', name: 'implement-auth', input: { issueId: fromSqid(issue1.id).id } },
    })

    const dequeued = await adapter.dequeue({ ns: nsId, kind: 'agent-run', limit: 1 })
    expect(dequeued).toHaveLength(1)

    await adapter.checkpoint({ id: run.id, step: 1, result: { action: 'read-codebase' } })
    await adapter.checkpoint({ id: run.id, step: 2, result: { action: 'write-code', files: 3 } })

    // 7. Cost tracking
    const agentId = fromSqid(agent.id).id
    await adapter.create({ ns: nsId, collection: 'cost-events', data: { kind: 'llm', amount: 500, agent: agentId } })
    await adapter.create({ ns: nsId, collection: 'cost-events', data: { kind: 'llm', amount: 300, agent: agentId } })

    // 8. Complete run
    await adapter.complete({ id: run.id, output: { pr: 'https://github.com/acme/platform/pull/42' } })

    // 9. Update issue status
    await adapter.updateOne({ ns: nsId, collection: 'issues', id: issue1.id, data: { status: 'done' } })

    // 10. Budget policy
    await adapter.create({ ns: nsId, collection: 'budget-policies', data: { name: 'Monthly Agent Budget', limit: 10000 } })

    // 11. Approval for next phase
    await adapter.create({ ns: nsId, collection: 'approvals', data: { title: 'Approve Phase 2 Budget', status: 'pending' } })

    // 12. Comment on issue
    await adapter.create({ ns: nsId, collection: 'comments', data: { body: 'Auth implementation complete, PR ready for review' } })

    // Verify the full workflow
    const issues = await adapter.find({ ns: nsId, collection: 'issues' })
    expect(issues.total).toBe(2)

    const doneIssues = await adapter.find({ ns: nsId, collection: 'issues', where: { status: { equals: 'done' } } })
    expect(doneIssues.total).toBe(1)

    const costs = await adapter.find({ ns: nsId, collection: 'cost-events' })
    expect(costs.total).toBe(2)

    const allRuns = await adapter.find({ ns: nsId, collection: 'agent-runs' })
    expect(allRuns.total).toBe(1)

  })
})

// BEAD n53: E2E COW with new collections
describe('E2E: COW branching with chat and agent collections', () => {
  it('branch modifies agent config, chat isolated, merge applies', async () => {
    const nsResult = await query<{ id: number }>(pool, `INSERT INTO ns (uri, name, kind) VALUES ('cow-e2e.test', 'COWE2E', 'production') RETURNING id`)
    const nsId = nsResult.rows[0].id
    await adapter.nsResolver.refresh()

    // Production: create agent + chat
    const agent = await adapter.create({ ns: nsId, collection: 'agents', data: { name: 'Prod Agent', config: { temperature: 0.5 } } })
    const chat = await adapter.create({ ns: nsId, collection: 'chats', data: { title: 'Prod Chat' } })

    // Create branch
    const branch = await adapter.createBranch({ parent: nsId, uri: 'cow-e2e.test/pr/1', branch: 'feat/hot-agent' })
    await adapter.nsResolver.refresh()

    // Branch: inherits agent + chat
    const branchAgents = await adapter.find({ ns: branch.id, collection: 'agents' })
    expect(branchAgents.total).toBe(1)
    const branchChats = await adapter.find({ ns: branch.id, collection: 'chats' })
    expect(branchChats.total).toBe(1)

    // Modify agent config in branch (COW fork)
    await adapter.updateOne({
      ns: branch.id, collection: 'agents', id: agent.id,
      data: { config: { temperature: 0.9 } },
    })

    // Add chat message in branch only
    const branchMsg = await adapter.create({
      ns: branch.id, collection: 'messages',
      data: { chat: fromSqid(chat.id).id, role: 'user', parts: [{ type: 'text', text: 'Branch message' }] },
    })

    // Branch sees modified agent
    const branchAgent = await adapter.findOne({ ns: branch.id, collection: 'agents', id: agent.id })
    expect((branchAgent!.config as Record<string, unknown>).temperature).toBe(0.9)

    // Production unchanged
    const prodAgent = await adapter.findOne({ ns: nsId, collection: 'agents', id: agent.id })
    expect((prodAgent!.config as Record<string, unknown>).temperature).toBe(0.5)

    // Merge branch → production
    const result = await adapter.mergeBranch(branch.id)
    expect(result.merged).toBeGreaterThan(0)

    // Production now has the hot agent config
    const mergedAgent = await adapter.findOne({ ns: nsId, collection: 'agents', id: agent.id })
    expect((mergedAgent!.config as Record<string, unknown>).temperature).toBe(0.9)
  })
})
