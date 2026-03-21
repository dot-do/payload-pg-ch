import type {
  BaseDatabaseAdapter,
  PaginatedDocs,
  DatabaseAdapterObj,
  CreateArgs,
  FindArgs,
  FindOneArgs,
  UpdateOneArgs,
  DeleteOneArgs,
  DeleteManyArgs,
  CountArgs,
  UpsertArgs,
  UpdateManyArgs,
  QueryDraftsArgs,
  CreateVersionArgs,
  FindVersionsArgs,
  UpdateVersionArgs,
  DeleteVersionsArgs,
  CreateGlobalArgs,
  FindGlobalArgs,
  UpdateGlobalArgs,
  CreateGlobalVersionArgs,
  FindGlobalVersionsArgs,
  UpdateGlobalVersionArgs,
  CountGlobalVersionArgs,
} from 'payload'
import type { TypeWithVersion } from 'payload'
import type { Payload, JsonObject, Where } from 'payload'
import { createDatabaseAdapter } from 'payload'
import { DocumentAdapter } from '../adapter.js'
import type { Where as InternalWhere } from '../types.js'
import { query } from '../db/pg.js'
import { fromSqid } from '../id/sqids.js'

export interface DocumentDBAdapterConfig {
  postgres: string
  /** Namespace string (domain/baseURL). Auto-creates if not found. Default: 'localhost' */
  ns?: string
  collections?: Record<string, { prefix: string }>
}

/**
 * Build a PaginatedDocs result from an array of docs and a total count.
 */
function paginate<T>(docs: T[], total: number, page: number, limit: number): PaginatedDocs<T> {
  const effectiveLimit = limit || total || 1
  const totalPages = Math.ceil(total / effectiveLimit) || 1
  const currentPage = page || 1
  const hasNextPage = currentPage < totalPages
  const hasPrevPage = currentPage > 1
  return {
    docs,
    totalDocs: total,
    totalPages,
    page: currentPage,
    limit: effectiveLimit,
    hasNextPage,
    hasPrevPage,
    nextPage: hasNextPage ? currentPage + 1 : null,
    prevPage: hasPrevPage ? currentPage - 1 : null,
    pagingCounter: (currentPage - 1) * effectiveLimit + 1,
  }
}

/**
 * Convert Payload sort format (e.g. '-createdAt', 'title') to our adapter sort string.
 * Payload may pass a string, string[], or Record<string, 'asc'|'desc'>.
 */
function normalizeSort(sort: unknown): string | undefined {
  if (!sort) return undefined
  if (typeof sort === 'string') return sort
  if (Array.isArray(sort)) return sort[0] as string | undefined
  if (typeof sort === 'object' && sort !== null) {
    const entries = Object.entries(sort as Record<string, string>)
    if (entries.length > 0) {
      const [field, dir] = entries[0]
      return dir === 'desc' || dir === 'DESC' ? `-${field}` : field
    }
  }
  return undefined
}

/**
 * Fields that Payload passes in data but should not be persisted.
 * Official adapters exclude these implicitly (Drizzle via allowlist, Mongoose via strict mode).
 * Since we store as JSONB, we must explicitly strip them.
 */
const NON_PERSISTABLE_FIELDS = new Set([
  'confirm-password',  // Form validation field, never persist
  '_strategy',         // Runtime auth context, added after read
  'collection',        // Stored as type column, not in data. Added by Payload after read
])

function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (!NON_PERSISTABLE_FIELDS.has(key)) {
      clean[key] = value
    }
  }
  return clean
}

/**
 * Extract the id value from a Payload where clause.
 * Returns the sqid string if found, undefined otherwise.
 * Looks in top-level { id: { equals: sqid } } and in nested and/or clauses.
 */
function extractIdFromWhere(where: Where | undefined): string | undefined {
  if (!where) return undefined
  const idField = where.id as { equals?: unknown } | undefined
  if (idField?.equals && typeof idField.equals === 'string') {
    return idField.equals
  }
  // Check nested and/or clauses
  for (const clause of where.and ?? []) {
    const nested = extractIdFromWhere(clause)
    if (nested) return nested
  }
  for (const clause of where.or ?? []) {
    const nested = extractIdFromWhere(clause)
    if (nested) return nested
  }
  return undefined
}

function convertWhere(where: Where | undefined): InternalWhere | undefined {
  if (!where || Object.keys(where).length === 0) return undefined
  // The `id` column is TEXT and stores sqid strings directly.
  // Do NOT decode sqid values to seq — Payload passes sqid strings which
  // match the id column as-is.
  return JSON.parse(JSON.stringify(where)) as InternalWhere
}

/**
 * Flatten a document from our adapter format to what Payload expects.
 */
function toPayloadDoc(result: { id: string } & Record<string, unknown>): Record<string, unknown> {
  return {
    ...result,
    createdAt: result.createdAt ?? result.created ?? new Date().toISOString(),
    updatedAt: result.updatedAt ?? result.updated ?? new Date().toISOString(),
  }
}

export function documentDBAdapter(config: DocumentDBAdapterConfig): DatabaseAdapterObj {
  const ns = config.ns ?? 'localhost'

  return {
    defaultIDType: 'text',
    name: 'payload-pg-ch',
    init: (args: { payload: Payload }) => {
      const adapter = new DocumentAdapter({
        postgres: config.postgres,
        ns,
        collections: config.collections,
      })

      const dbAdapter = createDatabaseAdapter<BaseDatabaseAdapter>({
        name: 'payload-pg-ch',
        packageName: 'payload-pg-ch',
        defaultIDType: 'text',
        payload: args.payload,

        // -- Connection lifecycle --

        connect: async () => {
          await adapter.init()
          // Ensure DDL schema exists
          try {
            await query(adapter.pool, 'SELECT 1 FROM data LIMIT 0', [])
          } catch (_e) {
            console.warn('[payload-pg-ch] data table not found. Run: npm run migrate:up')
          }

          // Ensure namespace doc exists, auto-create if not found
          const existing = await query<{ seq: number }>(
            adapter.pool,
            `SELECT seq FROM data WHERE type = 'namespaces' AND ns = $1 LIMIT 1`,
            [ns],
          )
          if (existing.rows.length > 0) {
            console.log(`[payload-pg-ch] Namespace '${ns}' found`)
          } else {
            await query(
              adapter.pool,
              `INSERT INTO data (id, ns, type, name, data, meta, rand)
               VALUES ($1, $2, 'namespaces', $3, '{}', '{"kind":"production"}', 0)`,
              [ns, ns, ns],
            )
            console.log(`[payload-pg-ch] Auto-created namespace '${ns}'`)
            await adapter.nsResolver.refresh()
          }
        },

        destroy: async () => {
          await adapter.destroy()
        },

        // -- Transactions (no-op; our adapter handles transactions internally) --

        beginTransaction: async () => {
          return null
        },

        commitTransaction: async () => {
          // no-op
        },

        rollbackTransaction: async () => {
          // no-op
        },

        // -- CRUD: Create --
        // Payload passes `collection` (string slug), we map to `type`

        create: async (args: CreateArgs) => {
          const result = await adapter.create({
            ns,
            type: args.collection,
            data: sanitizeData(args.data as Record<string, unknown>),
          })
          const doc = typeof result.doc === 'object' && result.doc !== null
            ? result.doc as Record<string, unknown>
            : {}
          return toPayloadDoc({ id: result.id, ...doc })
        },

        // -- CRUD: Find --

        find: async <T = Record<string, unknown>>(args: FindArgs): Promise<PaginatedDocs<T>> => {
          const page = args.page ?? 1
          const limit = args.limit ?? 10
          const offset = (page - 1) * limit

          const result = await adapter.find({
            ns,
            type: args.collection,
            where: convertWhere(args.where),
            sort: normalizeSort(args.sort),
            limit: limit === 0 ? undefined : limit,
            offset: limit === 0 ? undefined : offset,
          })

          const docs = result.docs.map(d => toPayloadDoc(d) as T)
          return paginate(docs, result.total, page, limit)
        },

        findOne: async <T extends { id: string | number }>(args: FindOneArgs): Promise<T | null> => {
          // Extract id from where clause for direct lookup (more efficient)
          const idFromWhere = extractIdFromWhere(args.where)
          if (idFromWhere) {
            const result = await adapter.findOne({
              ns,
              type: args.collection,
              id: idFromWhere,
            })
            if (!result) return null
            return toPayloadDoc(result) as T
          }

          const result = await adapter.findOne({
            ns,
            type: args.collection,
            where: convertWhere(args.where),
          })

          if (!result) return null
          return toPayloadDoc(result) as T
        },

        // -- CRUD: Update --

        updateOne: async (args: UpdateOneArgs) => {
          let docId: string | undefined

          if ('id' in args && args.id != null) {
            docId = String(args.id)
          } else if ('where' in args && args.where) {
            // Try to extract id directly from where clause first
            const idFromWhere = extractIdFromWhere(args.where)
            if (idFromWhere) {
              docId = idFromWhere
            } else {
              const found = await adapter.findOne({
                ns,
                type: args.collection,
                where: convertWhere(args.where) as InternalWhere,
              })
              if (!found) return { id: '' } as Record<string, unknown>
              docId = found.id
            }
          }

          if (!docId) return { id: '' } as Record<string, unknown>

          const result = await adapter.updateOne({
            ns,
            type: args.collection,
            id: docId,
            data: sanitizeData(args.data as Record<string, unknown>),
          })

          const doc = typeof result.doc === 'object' && result.doc !== null
            ? result.doc as Record<string, unknown>
            : {}
          return toPayloadDoc({ id: result.id, ...doc })
        },

        updateMany: async (args: UpdateManyArgs) => {
          const found = await adapter.find({
            ns,
            type: args.collection,
            where: convertWhere(args.where),
          })

          const results: Record<string, unknown>[] = []
          for (const doc of found.docs) {
            const result = await adapter.updateOne({
              ns,
              type: args.collection,
              id: doc.id,
              data: args.data,
            })
            const updatedDoc = typeof result.doc === 'object' && result.doc !== null
              ? result.doc as Record<string, unknown>
              : {}
            results.push(toPayloadDoc({ id: result.id, ...updatedDoc }))
          }
          return results
        },

        // -- CRUD: Delete --

        deleteOne: async (args: DeleteOneArgs) => {
          // Extract id from where for direct lookup
          const idFromWhere = extractIdFromWhere(args.where)
          const found = idFromWhere
            ? await adapter.findOne({ ns, type: args.collection, id: idFromWhere })
            : await adapter.findOne({ ns, type: args.collection, where: convertWhere(args.where) })

          if (!found) return { id: '' } as Record<string, unknown>

          await adapter.deleteMany({
            ns,
            type: args.collection,
            where: { seq: { equals: fromSqid(found.id).seq } },
          })

          return toPayloadDoc(found)
        },

        deleteMany: async (args: DeleteManyArgs) => {
          await adapter.deleteMany({
            ns,
            type: args.collection,
            where: convertWhere(args.where) as InternalWhere,
          })
        },

        // -- Count --

        count: async (args: CountArgs) => {
          const result = await adapter.find({
            ns,
            type: args.collection,
            where: convertWhere(args.where),
            limit: 0,
          })
          return { totalDocs: result.total }
        },

        // -- Upsert --

        upsert: async (args: UpsertArgs) => {
          const idFromWhere = extractIdFromWhere(args.where)
          const existing = idFromWhere
            ? await adapter.findOne({ ns, type: args.collection, id: idFromWhere })
            : await adapter.findOne({ ns, type: args.collection, where: convertWhere(args.where) })

          if (existing) {
            const result = await adapter.updateOne({
              ns,
              type: args.collection,
              id: existing.id,
              data: args.data,
            })
            const doc = typeof result.doc === 'object' && result.doc !== null
              ? result.doc as Record<string, unknown>
              : {}
            return toPayloadDoc({ id: result.id, ...doc })
          }

          const result = await adapter.create({
            ns,
            type: args.collection,
            data: args.data,
          })
          const doc = typeof result.doc === 'object' && result.doc !== null
            ? result.doc as Record<string, unknown>
            : {}
          return toPayloadDoc({ id: result.id, ...doc })
        },

        // -- Query Drafts --

        queryDrafts: async <T = Record<string, unknown>>(args: QueryDraftsArgs): Promise<PaginatedDocs<T>> => {
          const page = args.page ?? 1
          const limit = args.limit ?? 10
          const offset = (page - 1) * limit

          const where = convertWhere(args.where) ?? {}
          const draftWhere: InternalWhere = {
            ...where,
            and: [
              ...(where.and ?? []),
              { status: { equals: 'draft' } },
            ],
          }

          const result = await adapter.find({
            ns,
            type: args.collection,
            where: draftWhere,
            sort: normalizeSort(args.sort),
            limit,
            offset,
          })

          const docs = result.docs.map(d => toPayloadDoc(d) as T)
          return paginate(docs, result.total, page, limit)
        },

        // -- Globals --

        createGlobal: async <T extends Record<string, unknown>>(args: CreateGlobalArgs<T>): Promise<T> => {
          const result = await adapter.create({
            ns,
            type: '_globals',
            data: { ...args.data, globalSlug: args.slug, name: args.slug },
          })
          const doc = typeof result.doc === 'object' && result.doc !== null
            ? result.doc as Record<string, unknown>
            : {}
          return { id: result.id, ...doc } as unknown as T
        },

        findGlobal: async <T extends Record<string, unknown>>(args: FindGlobalArgs): Promise<T> => {
          // Query by name column which stores the globalSlug
          const result = await adapter.findOne({
            ns,
            type: '_globals',
            where: { name: { equals: args.slug } },
          })
          if (!result) return {} as unknown as T
          return toPayloadDoc(result) as unknown as T
        },

        updateGlobal: async <T extends Record<string, unknown>>(args: UpdateGlobalArgs<T>): Promise<T> => {
          const existing = await adapter.findOne({
            ns,
            type: '_globals',
            where: { name: { equals: args.slug } },
          })

          if (existing) {
            const result = await adapter.updateOne({
              ns,
              type: '_globals',
              id: existing.id,
              data: { ...args.data, globalSlug: args.slug, name: args.slug },
            })
            const doc = typeof result.doc === 'object' && result.doc !== null
              ? result.doc as Record<string, unknown>
              : {}
            return toPayloadDoc({ id: result.id, ...doc }) as unknown as T
          }

          // If not found, create it
          const result = await adapter.create({
            ns,
            type: '_globals',
            data: { ...args.data, globalSlug: args.slug, name: args.slug },
          })
          const doc = typeof result.doc === 'object' && result.doc !== null
            ? result.doc as Record<string, unknown>
            : {}
          return toPayloadDoc({ id: result.id, ...doc }) as unknown as T
        },

        // -- Versions --

        createVersion: async <T extends JsonObject>(args: CreateVersionArgs<T>): Promise<TypeWithVersion<T>> => {
          const versionDoc = {
            _versionOf: args.collectionSlug,
            parent: String(args.parent),
            version: args.versionData,
            autosave: args.autosave,
            latest: true,
            createdAt: args.createdAt,
            updatedAt: args.updatedAt,
            publishedLocale: args.publishedLocale,
            snapshot: args.snapshot ?? false,
          }

          // Mark previous versions as not latest
          const prevVersions = await adapter.find({
            ns,
            type: `_versions_${args.collectionSlug}`,
            where: {
              parent: { equals: String(args.parent) },
              latest: { equals: true },
            },
          })
          for (const prev of prevVersions.docs) {
            await adapter.updateOne({
              ns,
              type: `_versions_${args.collectionSlug}`,
              id: prev.id,
              data: { latest: false },
            })
          }

          const result = await adapter.create({
            ns,
            type: `_versions_${args.collectionSlug}`,
            data: versionDoc,
          })

          return {
            id: result.id,
            parent: String(args.parent),
            version: args.versionData,
            createdAt: args.createdAt,
            updatedAt: args.updatedAt,
            latest: true,
            publishedLocale: args.publishedLocale,
            snapshot: args.snapshot,
          }
        },

        findVersions: async <T = JsonObject>(args: FindVersionsArgs): Promise<PaginatedDocs<TypeWithVersion<T>>> => {
          const page = args.page ?? 1
          const limit = args.limit ?? 10
          const offset = (page - 1) * limit

          const result = await adapter.find({
            ns,
            type: `_versions_${args.collection}`,
            where: convertWhere(args.where),
            sort: normalizeSort(args.sort),
            limit,
            offset,
          })

          const docs: TypeWithVersion<T>[] = result.docs.map(d => ({
            id: d.id,
            parent: (d.parent as string) ?? '',
            version: (d.version as T) ?? ({} as T),
            createdAt: (d.createdAt as string) ?? (d.created as string) ?? new Date().toISOString(),
            updatedAt: (d.updatedAt as string) ?? (d.updated as string) ?? new Date().toISOString(),
            latest: (d.latest as boolean) ?? false,
            publishedLocale: d.publishedLocale as string | undefined,
            snapshot: (d.snapshot as boolean) ?? false,
          }))

          return paginate(docs, result.total, page, limit)
        },

        updateVersion: async <T extends JsonObject>(args: UpdateVersionArgs<T>): Promise<TypeWithVersion<T>> => {
          let docId: string | undefined

          if ('id' in args && args.id != null) {
            docId = String(args.id)
          } else if ('where' in args && args.where) {
            const idFromWhere = extractIdFromWhere(args.where)
            if (idFromWhere) {
              docId = idFromWhere
            } else {
              const found = await adapter.findOne({
                ns,
                type: `_versions_${args.collection}`,
                where: convertWhere(args.where) as InternalWhere,
              })
              if (found) docId = found.id
            }
          }

          if (!docId) {
            return {
              id: '',
              parent: '',
              version: args.versionData.version,
              createdAt: args.versionData.createdAt ?? new Date().toISOString(),
              updatedAt: args.versionData.updatedAt ?? new Date().toISOString(),
            }
          }

          const updateData: Record<string, unknown> = {}
          if (args.versionData.version !== undefined) updateData.version = args.versionData.version
          if (args.versionData.latest !== undefined) updateData.latest = args.versionData.latest
          if (args.versionData.parent !== undefined) updateData.parent = String(args.versionData.parent)
          if (args.versionData.createdAt !== undefined) updateData.createdAt = args.versionData.createdAt
          if (args.versionData.updatedAt !== undefined) updateData.updatedAt = args.versionData.updatedAt
          if (args.versionData.publishedLocale !== undefined) updateData.publishedLocale = args.versionData.publishedLocale

          const result = await adapter.updateOne({
            ns,
            type: `_versions_${args.collection}`,
            id: docId,
            data: updateData,
          })

          const doc = typeof result.doc === 'object' && result.doc !== null
            ? result.doc as Record<string, unknown>
            : {}
          return {
            id: result.id,
            parent: (doc.parent as string) ?? '',
            version: (doc.version as T) ?? args.versionData.version,
            createdAt: (doc.createdAt as string) ?? new Date().toISOString(),
            updatedAt: (doc.updatedAt as string) ?? new Date().toISOString(),
            latest: (doc.latest as boolean) ?? false,
            publishedLocale: doc.publishedLocale as string | undefined,
          }
        },

        deleteVersions: async (args: DeleteVersionsArgs) => {
          const type = args.collection
            ? `_versions_${args.collection}`
            : args.globalSlug
              ? `_versions__globals_${args.globalSlug}`
              : '_versions'

          await adapter.deleteMany({
            ns,
            type,
            where: convertWhere(args.where) as InternalWhere,
          })
        },

        countVersions: async (args: CountArgs) => {
          const result = await adapter.find({
            ns,
            type: `_versions_${args.collection}`,
            where: convertWhere(args.where),
            limit: 0,
          })
          return { totalDocs: result.total }
        },

        // -- Global Versions --

        createGlobalVersion: async <T extends JsonObject>(args: CreateGlobalVersionArgs<T>): Promise<Omit<TypeWithVersion<T>, 'parent'>> => {
          const versionDoc = {
            _versionOfGlobal: args.globalSlug,
            version: args.versionData,
            autosave: args.autosave,
            latest: true,
            createdAt: args.createdAt,
            updatedAt: args.updatedAt,
            publishedLocale: args.publishedLocale,
            snapshot: args.snapshot ?? false,
          }

          // Mark previous global versions as not latest
          const prevVersions = await adapter.find({
            ns,
            type: `_versions__globals_${args.globalSlug}`,
            where: { latest: { equals: true } },
          })
          for (const prev of prevVersions.docs) {
            await adapter.updateOne({
              ns,
              type: `_versions__globals_${args.globalSlug}`,
              id: prev.id,
              data: { latest: false },
            })
          }

          const result = await adapter.create({
            ns,
            type: `_versions__globals_${args.globalSlug}`,
            data: versionDoc,
          })

          return {
            id: result.id,
            version: args.versionData,
            createdAt: args.createdAt,
            updatedAt: args.updatedAt,
            latest: true,
            publishedLocale: args.publishedLocale,
            snapshot: args.snapshot,
          }
        },

        findGlobalVersions: async <T = JsonObject>(args: FindGlobalVersionsArgs): Promise<PaginatedDocs<TypeWithVersion<T>>> => {
          const page = args.page ?? 1
          const limit = args.limit ?? 10
          const offset = (page - 1) * limit

          const result = await adapter.find({
            ns,
            type: `_versions__globals_${args.global}`,
            where: convertWhere(args.where),
            sort: normalizeSort(args.sort),
            limit,
            offset,
          })

          const docs: TypeWithVersion<T>[] = result.docs.map(d => ({
            id: d.id,
            parent: (d.parent as string) ?? '',
            version: (d.version as T) ?? ({} as T),
            createdAt: (d.createdAt as string) ?? (d.created as string) ?? new Date().toISOString(),
            updatedAt: (d.updatedAt as string) ?? (d.updated as string) ?? new Date().toISOString(),
            latest: (d.latest as boolean) ?? false,
            publishedLocale: d.publishedLocale as string | undefined,
          }))

          return paginate(docs, result.total, page, limit)
        },

        updateGlobalVersion: async <T extends JsonObject>(args: UpdateGlobalVersionArgs<T>): Promise<TypeWithVersion<T>> => {
          let docId: string | undefined

          if ('id' in args && args.id != null) {
            docId = String(args.id)
          } else if ('where' in args && args.where) {
            const idFromWhere = extractIdFromWhere(args.where)
            if (idFromWhere) {
              docId = idFromWhere
            } else {
              const found = await adapter.findOne({
                ns,
                type: `_versions__globals_${args.global}`,
                where: convertWhere(args.where) as InternalWhere,
              })
              if (found) docId = found.id
            }
          }

          if (!docId) {
            return {
              id: '',
              parent: '',
              version: args.versionData.version,
              createdAt: args.versionData.createdAt ?? new Date().toISOString(),
              updatedAt: args.versionData.updatedAt ?? new Date().toISOString(),
            }
          }

          const updateData: Record<string, unknown> = {}
          if (args.versionData.version !== undefined) updateData.version = args.versionData.version
          if (args.versionData.latest !== undefined) updateData.latest = args.versionData.latest
          if (args.versionData.createdAt !== undefined) updateData.createdAt = args.versionData.createdAt
          if (args.versionData.updatedAt !== undefined) updateData.updatedAt = args.versionData.updatedAt
          if (args.versionData.publishedLocale !== undefined) updateData.publishedLocale = args.versionData.publishedLocale

          const result = await adapter.updateOne({
            ns,
            type: `_versions__globals_${args.global}`,
            id: docId,
            data: updateData,
          })

          const doc = typeof result.doc === 'object' && result.doc !== null
            ? result.doc as Record<string, unknown>
            : {}
          return {
            id: result.id,
            parent: (doc.parent as string) ?? '',
            version: (doc.version as T) ?? args.versionData.version,
            createdAt: (doc.createdAt as string) ?? new Date().toISOString(),
            updatedAt: (doc.updatedAt as string) ?? new Date().toISOString(),
            latest: (doc.latest as boolean) ?? false,
            publishedLocale: doc.publishedLocale as string | undefined,
          }
        },

        countGlobalVersions: async (args: CountGlobalVersionArgs) => {
          const result = await adapter.find({
            ns,
            type: `_versions__globals_${args.global}`,
            where: convertWhere(args.where),
            limit: 0,
          })
          return { totalDocs: result.total }
        },

        // -- Find Distinct --

        findDistinct: async (args) => {
          const page = args.page ?? 1
          const limit = args.limit ?? 10
          const offset = (page - 1) * limit

          // Use raw SQL to get distinct values for a field from the data JSONB
          const field = args.field
          const conditions = ['ns = $1', 'type = $2']
          const params: unknown[] = [ns, args.collection]
          let paramIdx = 3

          if (args.where && Object.keys(args.where).length > 0) {
            // For simplicity, we do a basic pass-through
            // A full implementation would use whereToSQL here
          }

          params.push(limit, offset)
          const sql = `
            SELECT DISTINCT data->>'${field}' AS value, count(*) OVER() AS total
            FROM data
            WHERE ${conditions.join(' AND ')}
            ORDER BY value
            LIMIT $${paramIdx++} OFFSET $${paramIdx++}
          `

          const result = await query<{ value: string; total: string }>(
            adapter.pool,
            sql,
            params,
          )

          const total = result.rows.length > 0 ? parseInt(result.rows[0].total, 10) : 0
          const values = result.rows.map(r => ({ [field]: r.value }))
          const totalPages = Math.ceil(total / limit) || 1

          return {
            values,
            totalDocs: total,
            totalPages,
            page,
            limit,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1,
            nextPage: page < totalPages ? page + 1 : null,
            prevPage: page > 1 ? page - 1 : null,
            pagingCounter: (page - 1) * limit + 1,
          }
        },

        // -- Jobs (updateJobs) --

        updateJobs: async (args) => {
          if ('id' in args && args.id != null) {
            const result = await adapter.updateOne({
              ns,
              type: 'payload-jobs',
              id: String(args.id),
              data: args.data,
            })
            const doc = typeof result.doc === 'object' && result.doc !== null
              ? result.doc as Record<string, unknown>
              : {}
            return [toPayloadDoc({ id: result.id, ...doc })] as never
          }

          if ('where' in args && args.where) {
            const found = await adapter.find({
              ns,
              type: 'payload-jobs',
              where: convertWhere(args.where),
              limit: args.limit,
            })

            const results = []
            for (const d of found.docs) {
              const result = await adapter.updateOne({
                ns,
                type: 'payload-jobs',
                id: d.id,
                data: args.data,
              })
              const doc = typeof result.doc === 'object' && result.doc !== null
                ? result.doc as Record<string, unknown>
                : {}
              results.push(toPayloadDoc({ id: result.id, ...doc }))
            }
            return results as never
          }

          return null
        },
      })

      return dbAdapter
    },
  }
}
