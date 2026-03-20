export { DocumentAdapter } from './adapter.js'
export { toSqid, fromSqid, registerPrefix, generateRand, getPrefix } from './id/sqids.js'
export { createPool, transaction, query } from './db/pg.js'
export { whereToSQL } from './db/where.js'
export { NsResolver } from './ns/resolver.js'
export { createBranch, mergeBranch, cleanupBranch, cleanupExpiredPreviews } from './ns/branch.js'

// Query modules
export * as dataQueries from './db/queries/data.js'
export * as relQueries from './db/queries/rels.js'
export * as logQueries from './db/queries/log.js'
export * as actionQueries from './db/queries/actions.js'
export * as pendingQueries from './db/queries/pending.js'
export * as searchQueries from './db/queries/search.js'

// Types
export type {
  Sqid, NsRow, DataRow, RelRow, LogRow, ActionRow, PendingRow, SearchRow,
  Where, WhereField, RequestMeta, CollectionTier, CollectionSchema, FieldSchema,
  AdapterConfig,
} from './types.js'

export type { PgPool, PgPoolClient, PoolConfig } from './db/pg.js'

// Payload CMS database adapter bridge
export { documentDBAdapter } from './payload/database-adapter.js'
export type { DocumentDBAdapterConfig } from './payload/database-adapter.js'
