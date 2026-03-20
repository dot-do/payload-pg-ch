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
import type pg from 'pg'

export interface DocumentDBAdapterConfig {
  postgres: string
  ns?: number
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
 * Convert a Payload Where clause to our internal Where type.
 * Payload uses the same operator format so this is mostly a passthrough,
 * but we need to handle the `id` field specially since Payload uses sqid strings.
 */
function convertWhere(where: Where | undefined): InternalWhere | undefined {
  if (!where || Object.keys(where).length === 0) return undefined

  // Deep clone to avoid mutating the original
  const converted = JSON.parse(JSON.stringify(where)) as InternalWhere

  return converted
}

/**
 * Flatten a document from our adapter format to what Payload expects.
 * Our adapter returns { id, ...docFields } which is what Payload wants.
 */
function toPayloadDoc(result: { id: string } & Record<string, unknown>): Record<string, unknown> {
  return {
    ...result,
    createdAt: result.createdAt ?? result.created ?? new Date().toISOString(),
    updatedAt: result.updatedAt ?? result.updated ?? new Date().toISOString(),
  }
}

export function documentDBAdapter(config: DocumentDBAdapterConfig): DatabaseAdapterObj {
  const ns = config.ns ?? 1

  return {
    defaultIDType: 'text',
    name: 'payload-pg-ch',
    init: (args: { payload: Payload }) => {
      const adapter = new DocumentAdapter({
        postgres: config.postgres,
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
          // Ensure DDL schema exists by running a lightweight check
          // The schema should already be applied, but we verify the data table exists.
          try {
            await query(adapter.pool as unknown as pg.Pool, 'SELECT 1 FROM data LIMIT 0', [])
          } catch (_e) {
            // Schema not applied - callers should run sql/pg/*.sql files
            console.warn('[payload-pg-ch] data table not found. Ensure DDL from sql/pg/*.sql is applied.')
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

        create: async (args: CreateArgs) => {
          const result = await adapter.create({
            ns,
            collection: args.collection,
            data: args.data,
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
            collection: args.collection,
            where: convertWhere(args.where),
            sort: normalizeSort(args.sort),
            limit: limit === 0 ? undefined : limit,
            offset: limit === 0 ? undefined : offset,
          })

          const docs = result.docs.map(d => toPayloadDoc(d) as T)
          return paginate(docs, result.total, page, limit)
        },

        findOne: async <T extends { id: string | number }>(args: FindOneArgs): Promise<T | null> => {
          const result = await adapter.findOne({
            ns,
            collection: args.collection,
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
            const found = await adapter.findOne({
              ns,
              collection: args.collection,
              where: convertWhere(args.where) as InternalWhere,
            })
            if (!found) return { id: '' } as Record<string, unknown>
            docId = found.id
          }

          if (!docId) return { id: '' } as Record<string, unknown>

          const result = await adapter.updateOne({
            ns,
            collection: args.collection,
            id: docId,
            data: args.data,
          })

          const doc = typeof result.doc === 'object' && result.doc !== null
            ? result.doc as Record<string, unknown>
            : {}
          return toPayloadDoc({ id: result.id, ...doc })
        },

        updateMany: async (args: UpdateManyArgs) => {
          const found = await adapter.find({
            ns,
            collection: args.collection,
            where: convertWhere(args.where),
          })

          const results: Record<string, unknown>[] = []
          for (const doc of found.docs) {
            const result = await adapter.updateOne({
              ns,
              collection: args.collection,
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
          const found = await adapter.findOne({
            ns,
            collection: args.collection,
            where: convertWhere(args.where),
          })

          if (!found) return { id: '' } as Record<string, unknown>

          await adapter.deleteMany({
            ns,
            collection: args.collection,
            where: { id: { equals: found.id } },
          })

          return toPayloadDoc(found)
        },

        deleteMany: async (args: DeleteManyArgs) => {
          await adapter.deleteMany({
            ns,
            collection: args.collection,
            where: convertWhere(args.where) as InternalWhere,
          })
        },

        // -- Count --

        count: async (args: CountArgs) => {
          const result = await adapter.find({
            ns,
            collection: args.collection,
            where: convertWhere(args.where),
            limit: 0,
          })
          return { totalDocs: result.total }
        },

        // -- Upsert --

        upsert: async (args: UpsertArgs) => {
          const existing = await adapter.findOne({
            ns,
            collection: args.collection,
            where: convertWhere(args.where),
          })

          if (existing) {
            const result = await adapter.updateOne({
              ns,
              collection: args.collection,
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
            collection: args.collection,
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
            collection: args.collection,
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
            collection: '_globals',
            data: { ...args.data, _globalSlug: args.slug },
          })
          const doc = typeof result.doc === 'object' && result.doc !== null
            ? result.doc as Record<string, unknown>
            : {}
          return { id: result.id, ...doc } as unknown as T
        },

        findGlobal: async <T extends Record<string, unknown>>(args: FindGlobalArgs): Promise<T> => {
          const result = await adapter.findOne({
            ns,
            collection: '_globals',
            where: { _globalSlug: { equals: args.slug } },
          })
          if (!result) return {} as unknown as T
          return result as unknown as T
        },

        updateGlobal: async <T extends Record<string, unknown>>(args: UpdateGlobalArgs<T>): Promise<T> => {
          const existing = await adapter.findOne({
            ns,
            collection: '_globals',
            where: { _globalSlug: { equals: args.slug } },
          })

          if (existing) {
            const result = await adapter.updateOne({
              ns,
              collection: '_globals',
              id: existing.id,
              data: { ...args.data, _globalSlug: args.slug },
            })
            const doc = typeof result.doc === 'object' && result.doc !== null
              ? result.doc as Record<string, unknown>
              : {}
            return { id: result.id, ...doc } as unknown as T
          }

          // If not found, create it
          const result = await adapter.create({
            ns,
            collection: '_globals',
            data: { ...args.data, _globalSlug: args.slug },
          })
          const doc = typeof result.doc === 'object' && result.doc !== null
            ? result.doc as Record<string, unknown>
            : {}
          return { id: result.id, ...doc } as unknown as T
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
            collection: `_versions_${args.collectionSlug}`,
            where: {
              parent: { equals: String(args.parent) },
              latest: { equals: true },
            },
          })
          for (const prev of prevVersions.docs) {
            await adapter.updateOne({
              ns,
              collection: `_versions_${args.collectionSlug}`,
              id: prev.id,
              data: { latest: false },
            })
          }

          const result = await adapter.create({
            ns,
            collection: `_versions_${args.collectionSlug}`,
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
            collection: `_versions_${args.collection}`,
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
            const found = await adapter.findOne({
              ns,
              collection: `_versions_${args.collection}`,
              where: convertWhere(args.where) as InternalWhere,
            })
            if (found) docId = found.id
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
            collection: `_versions_${args.collection}`,
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
          const collection = args.collection
            ? `_versions_${args.collection}`
            : args.globalSlug
              ? `_versions__globals_${args.globalSlug}`
              : '_versions'

          await adapter.deleteMany({
            ns,
            collection,
            where: convertWhere(args.where) as InternalWhere,
          })
        },

        countVersions: async (args: CountArgs) => {
          const result = await adapter.find({
            ns,
            collection: `_versions_${args.collection}`,
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
            collection: `_versions__globals_${args.globalSlug}`,
            where: { latest: { equals: true } },
          })
          for (const prev of prevVersions.docs) {
            await adapter.updateOne({
              ns,
              collection: `_versions__globals_${args.globalSlug}`,
              id: prev.id,
              data: { latest: false },
            })
          }

          const result = await adapter.create({
            ns,
            collection: `_versions__globals_${args.globalSlug}`,
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
            collection: `_versions__globals_${args.global}`,
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
            const found = await adapter.findOne({
              ns,
              collection: `_versions__globals_${args.global}`,
              where: convertWhere(args.where) as InternalWhere,
            })
            if (found) docId = found.id
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
            collection: `_versions__globals_${args.global}`,
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
            collection: `_versions__globals_${args.global}`,
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

          // Use raw SQL to get distinct values for a field from the doc JSONB
          const field = args.field
          const conditions = ['ns = $1', 'collection = $2']
          const params: unknown[] = [ns, args.collection]
          let paramIdx = 3

          if (args.where && Object.keys(args.where).length > 0) {
            // For simplicity, we do a basic pass-through
            // A full implementation would use whereToSQL here
          }

          params.push(limit, offset)
          const sql = `
            SELECT DISTINCT doc->>'${field}' AS value, count(*) OVER() AS total
            FROM data
            WHERE ${conditions.join(' AND ')}
            ORDER BY value
            LIMIT $${paramIdx++} OFFSET $${paramIdx++}
          `

          const result = await query<{ value: string; total: string }>(
            adapter.pool as unknown as pg.Pool,
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
              collection: 'payload-jobs',
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
              collection: 'payload-jobs',
              where: convertWhere(args.where),
              limit: args.limit,
            })

            const results = []
            for (const d of found.docs) {
              const result = await adapter.updateOne({
                ns,
                collection: 'payload-jobs',
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
