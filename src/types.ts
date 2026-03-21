export type Sqid<P extends string = string> = `${P}_${string}`

export interface NsRow {
  id: number
  uri: string
  name: string | null
  config: unknown
  plan: string
  parent: number | null
  kind: string
  ttl: string | null
  merged: Date | null
  pr: number | null
  workosorg: string | null
  stripe: string | null
  connect: string | null
  subscription: string | null
  onboarded: boolean
  githuborgid: number | null
  githubuserid: number | null
  repo: string | null
  branch: string
  root: string
  synced: Date | null
  commit: string | null
  created: Date
  updated: Date
}

export interface DataRow {
  id: number
  ns: number
  collection: string
  slug: string | null
  doc: unknown
  meta: unknown
  status: string | null
  locale: string | null
  version: number
  rand: number
  created: Date
  updated: Date
  embedding: number[] | null
}

export interface RelRow {
  id: number
  ns: number
  from: number
  to: number
  path: string
  sort: number
  meta: unknown
}

export interface EventRow {
  id: number
  ns: number
  kind: string
  entity: number | null
  collection: string | null
  actor: number | null
  data: unknown
  meta: unknown
  created: Date
}

export interface ActionRow {
  id: number
  ns: number
  kind: string
  name: string
  status: string
  input: unknown
  output: unknown
  error: unknown
  steps: unknown[]
  cursor: number
  retries: number
  cap: number
  scheduled: Date | null
  started: Date | null
  completed: Date | null
  deadline: Date | null
  parent: number | null
  entity: number | null
  rand: number
  created: Date
  updated: Date
}

export interface SearchRow {
  id: number
  ns: number
  entity: number
  collection: string
  version: number
  title: string | null
  body: string | null
  tags: string[]
  locale: string | null
  meta: unknown
  embedding: number[] | null
  created: Date
  updated: Date
}

export interface RequestMeta {
  ip: string
  agent: string
  method: string
  path: string
}

export type CollectionTier = 'pg' | 'ch'

export interface WhereField {
  equals?: unknown
  not_equals?: unknown
  in?: unknown[]
  not_in?: unknown[]
  like?: string
  contains?: string
  greater_than?: unknown
  less_than?: unknown
  greater_than_equal?: unknown
  less_than_equal?: unknown
  exists?: boolean
}

export interface Where {
  [field: string]: WhereField | Where[] | undefined
  and?: Where[]
  or?: Where[]
}

export interface CollectionSchema {
  slug: string
  fields: FieldSchema[]
}

export interface FieldSchema {
  name: string
  type: string
  relationTo?: string | string[]
  hasMany?: boolean
  fields?: FieldSchema[]
}

export interface AdapterConfig {
  postgres: string | { connectionString: string; max?: number }
  clickhouse?: { host: string; port: number; database: string }
  workos?: { apiKey: string; clientId: string }
  stripe?: { secretKey: string; webhookSecret: string; connectWebhookSecret?: string }
  github?: { appId: string; privateKey: string; webhookSecret: string }
  collections?: Record<string, { prefix: string }>
  embedding?: { provider: 'gemini' | 'openai'; apiKey: string; dims?: number }
}
