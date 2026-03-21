export type Sqid<P extends string = string> = `${P}_${string}`

export interface DataRow {
  seq: number
  id: string
  ns: string
  type: string
  name: string | null
  slug: string | null
  url: string | null
  mdx: string | null
  data: unknown
  code: string | null
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
  seq: number
  ns: string
  from: number
  to: number
  path: string | null
  sort: number
  meta: unknown
}

export interface ActionRow {
  seq: number
  id: string
  ns: string
  type: string
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

export interface EventRow {
  seq: number
  ns: string
  kind: string
  entity: number | null
  type: string | null
  actor: number | null
  data: unknown
  meta: unknown
  created: Date
}

export interface SearchRow {
  seq: number
  ns: string
  entity: number
  type: string
  version: number
  name: string | null
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
  postgres: string
  ns: string
  clickhouse?: { host: string; port: number; database: string }
  workos?: { apiKey: string; clientId: string }
  stripe?: { secretKey: string; webhookSecret: string; connectWebhookSecret?: string }
  github?: { appId: string; privateKey: string; webhookSecret: string }
  collections?: Record<string, { prefix: string }>
  embedding?: { provider: 'gemini' | 'openai'; apiKey: string; dims?: number }
}
