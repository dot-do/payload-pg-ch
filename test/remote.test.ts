import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DocumentAdapter } from '../src/adapter.js'
import { createRpcHandler } from '../src/remote/server.js'
import { RemoteDocumentAdapter } from '../src/remote/client.js'
import { setupTestSchema, createTestNs } from './setup.js'

const TEST_NS = 'test-remote'
const TEST_TOKEN = 'test-jwt-token'
const TEST_CONNECTION = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

describe('Remote Adapter (client → server → local)', () => {
  let localAdapter: DocumentAdapter
  let handler: (req: Request) => Promise<Response>
  let remote: RemoteDocumentAdapter

  beforeAll(async () => {
    await setupTestSchema()
    await createTestNs(TEST_NS, 'Test Remote')

    // Local adapter (the real PG backend)
    localAdapter = new DocumentAdapter({ postgres: TEST_CONNECTION, ns: TEST_NS })
    await localAdapter.init()

    // RPC server handler wrapping the local adapter
    handler = createRpcHandler({
      adapter: localAdapter,
      auth: async (token) => {
        if (token !== TEST_TOKEN) throw new Error('Invalid token')
        return { ns: TEST_NS }
      },
    })

    // Remote adapter (HTTP client) with custom fetch that calls handler directly
    remote = new RemoteDocumentAdapter({
      url: 'http://localhost:0',
      token: TEST_TOKEN,
      ns: TEST_NS,
      fetch: async (input, init) => {
        const req = new Request(input, init)
        return handler(req)
      },
    })

    await remote.init()
  })

  afterAll(async () => {
    await remote.destroy()
    // Clean up test data
    try {
      await localAdapter.deleteMany({ ns: TEST_NS, type: 'remote-test', where: {} })
    } catch {}
    await localAdapter.destroy()
  })

  it('should ping the server', async () => {
    const result = await remote.checkSchema()
    expect(result).toBe(true)
  })

  it('should create a document via remote', async () => {
    const result = await remote.create({
      ns: TEST_NS,
      type: 'remote-test',
      data: { title: 'Hello Remote', status: 'published' },
    })
    expect(result.id).toBeTruthy()
    expect(typeof result.id).toBe('string')
  })

  it('should find documents via remote', async () => {
    const result = await remote.find({
      ns: TEST_NS,
      type: 'remote-test',
    })
    expect(result.total).toBeGreaterThanOrEqual(1)
    expect(result.docs.length).toBeGreaterThanOrEqual(1)
    expect(result.docs[0].title).toBe('Hello Remote')
  })

  it('should findOne via remote', async () => {
    const all = await remote.find({ ns: TEST_NS, type: 'remote-test' })
    const doc = await remote.findOne({
      ns: TEST_NS,
      type: 'remote-test',
      id: all.docs[0].id,
    })
    expect(doc).not.toBeNull()
    expect(doc!.title).toBe('Hello Remote')
  })

  it('should update a document via remote', async () => {
    const all = await remote.find({ ns: TEST_NS, type: 'remote-test' })
    const result = await remote.updateOne({
      ns: TEST_NS,
      type: 'remote-test',
      id: all.docs[0].id,
      data: { title: 'Updated Remote' },
    })
    expect(result.id).toBeTruthy()

    const updated = await remote.findOne({
      ns: TEST_NS,
      type: 'remote-test',
      id: all.docs[0].id,
    })
    expect(updated!.title).toBe('Updated Remote')
  })

  it('should find with where clause via remote', async () => {
    const result = await remote.find({
      ns: TEST_NS,
      type: 'remote-test',
      where: { title: { equals: 'Updated Remote' } },
    })
    expect(result.total).toBe(1)
    expect(result.docs[0].title).toBe('Updated Remote')
  })

  it('should delete via remote', async () => {
    const result = await remote.deleteMany({
      ns: TEST_NS,
      type: 'remote-test',
      where: { title: { equals: 'Updated Remote' } },
    })
    expect(result.deleted).toBe(1)

    const after = await remote.find({ ns: TEST_NS, type: 'remote-test' })
    expect(after.total).toBe(0)
  })

  it('should enforce namespace scoping (cannot override ns)', async () => {
    // Create with a different ns — server should override to TEST_NS
    const result = await remote.create({
      ns: 'evil-namespace',
      type: 'remote-test',
      data: { title: 'Scoped Test' },
    })
    expect(result.id).toBeTruthy()

    // Should be findable in TEST_NS, not evil-namespace
    const found = await remote.find({ ns: TEST_NS, type: 'remote-test' })
    expect(found.docs.some(d => d.title === 'Scoped Test')).toBe(true)

    // Clean up
    await remote.deleteMany({
      ns: TEST_NS,
      type: 'remote-test',
      where: { title: { equals: 'Scoped Test' } },
    })
  })

  it('should reject invalid auth', async () => {
    const badRemote = new RemoteDocumentAdapter({
      url: 'http://localhost:0',
      token: 'bad-token',
      ns: TEST_NS,
      fetch: async (input, init) => handler(new Request(input, init)),
    })

    await expect(badRemote.init()).rejects.toThrow()
  })

  it('should ensureNamespace', async () => {
    await expect(remote.ensureNamespace(TEST_NS)).resolves.not.toThrow()
  })
})
