import Sqids from 'sqids'

// Default alphabet — matches ClickHouse's sqidEncode/sqidDecode
const sqids = new Sqids({ minLength: 10 })

// Collection slug → 3-char prefix registry
const PREFIXES: Record<string, string> = {
  // Core
  nouns: 'nou', verbs: 'vrb', things: 'thn', 'action-defs': 'acd',
  // Chat
  chats: 'cht', messages: 'msg', votes: 'vot', documents: 'doc',
  suggestions: 'sug', streams: 'stm',
  // Agents
  agents: 'agt', models: 'mdl', prompts: 'pmt', tools: 'tol',
  memories: 'mem', 'agent-runs': 'arn', 'agent-sessions': 'asn',
  // Code
  functions: 'fun', workflows: 'wfl', packages: 'pkg', modules: 'mod',
  components: 'cmp',
  // Orchestration
  issues: 'iss', projects: 'prj', goals: 'gol', approvals: 'apr',
  comments: 'cmn',
  // Identity
  users: 'usr', organizations: 'org', teams: 'tam', roles: 'rol',
  'api-keys': 'key', accounts: 'acc',
  // Integrations
  integrations: 'int', connections: 'con', webhooks: 'whk',
  // Discovery
  domains: 'dom', directories: 'dir', sources: 'src', resources: 'rsc',
  // Events
  events: 'evt', versions: 'ver', search: 'sch',
  // Finance
  'cost-events': 'cst', 'budget-policies': 'bgt',
  // Media
  media: 'med',
  // Internal Payload collections
  '_globals': 'glb',
  // Legacy (backward compat)
  posts: 'pos', pages: 'pag', products: 'prd', orders: 'ord',
  categories: 'cat', tags: 'tag', actions: 'act',
}

export function registerPrefix(collection: string, prefix: string): void {
  PREFIXES[collection] = prefix
}

export function getPrefix(collection: string): string {
  if (PREFIXES[collection]) return PREFIXES[collection]
  // For internal collections like _versions_posts, derive from the base collection
  if (collection.startsWith('_versions_')) {
    const base = collection.slice('_versions_'.length)
    const basePrefix = PREFIXES[base] ?? base.replace(/[^a-z]/g, '').slice(0, 3)
    return `v${basePrefix.slice(0, 2)}`  // e.g., _versions_posts -> vpo, _versions_categories -> vca
  }
  // Strip leading underscores for prefix derivation
  const clean = collection.replace(/^_+/, '')
  return clean.slice(0, 3) || 'doc'
}

export function toSqid(
  collection: string,
  id: number,
  ns: number,
  created: Date,
  rand: number,
): string {
  const prefix = getPrefix(collection)
  const epoch = Math.floor(created.getTime() / 1000)
  return `${prefix}_${sqids.encode([ns, id, epoch, rand])}`
}

export function fromSqid(sqid: string): {
  prefix: string
  ns: number
  id: number
  epoch: number
  rand: number
} {
  const underscoreIdx = sqid.indexOf('_')
  if (underscoreIdx === -1) {
    throw new Error(`Invalid sqid: missing prefix separator`)
  }
  const prefix = sqid.slice(0, underscoreIdx)
  const encoded = sqid.slice(underscoreIdx + 1)
  const decoded = sqids.decode(encoded)
  if (decoded.length < 4) {
    throw new Error(`Invalid sqid: expected 4 components, got ${decoded.length}`)
  }
  const [ns, id, epoch, rand] = decoded

  // Canonicality check: re-encode and compare
  const reencoded = sqids.encode([ns, id, epoch, rand])
  if (reencoded !== encoded) {
    throw new Error(`Invalid sqid: non-canonical encoding`)
  }

  return { prefix, ns, id, epoch, rand }
}

export function generateRand(): number {
  const arr = new Uint16Array(1)
  crypto.getRandomValues(arr)
  return arr[0]
}
