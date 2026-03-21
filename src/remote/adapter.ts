import type { DatabaseAdapterObj, Payload } from 'payload'
import { createDatabaseAdapter } from 'payload'
import type { BaseDatabaseAdapter, PaginatedDocs } from 'payload'
import type { RemoteAdapterConfig } from './client.js'
import { RemoteDocumentAdapter } from './client.js'

// Re-use the bridge utilities from the main adapter
// These are pure functions with no PG dependency
import type { Where as InternalWhere } from '../types.js'

const NON_PERSISTABLE_FIELDS = new Set([
  'confirm-password',
  '_strategy',
  'collection',
])

function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (!NON_PERSISTABLE_FIELDS.has(key)) clean[key] = value
  }
  return clean
}

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

function extractIdFromWhere(where: Record<string, unknown> | undefined): string | undefined {
  if (!where) return undefined
  const idField = where.id as { equals?: unknown } | undefined
  if (idField?.equals && typeof idField.equals === 'string') return idField.equals
  for (const clause of (where.and as Record<string, unknown>[]) ?? []) {
    const nested = extractIdFromWhere(clause)
    if (nested) return nested
  }
  for (const clause of (where.or as Record<string, unknown>[]) ?? []) {
    const nested = extractIdFromWhere(clause)
    if (nested) return nested
  }
  return undefined
}

function convertWhere(where: Record<string, unknown> | undefined): InternalWhere | undefined {
  if (!where || Object.keys(where).length === 0) return undefined
  return JSON.parse(JSON.stringify(where)) as InternalWhere
}

function toPayloadDoc(result: { id: string } & Record<string, unknown>): Record<string, unknown> {
  return {
    ...result,
    createdAt: result.createdAt ?? result.created ?? new Date().toISOString(),
    updatedAt: result.updatedAt ?? result.updated ?? new Date().toISOString(),
  }
}

/**
 * Create a Payload database adapter that talks to a remote platform.do server.
 * No PG/CH credentials needed — just a URL and JWT.
 *
 * Usage:
 * ```ts
 * import { remoteDBAdapter } from 'payload-pg-ch/remote'
 *
 * export default buildConfig({
 *   db: remoteDBAdapter({
 *     url: 'https://platform.do',
 *     token: process.env.PLATFORM_TOKEN,
 *     ns: 'crm.headless.ly',
 *   }),
 *   collections: [...],
 * })
 * ```
 */
export function remoteDBAdapter(config: RemoteAdapterConfig): DatabaseAdapterObj {
  const ns = config.ns

  return {
    defaultIDType: 'text',
    name: 'payload-remote',
    init: (args: { payload: Payload }) => {
      const adapter = new RemoteDocumentAdapter(config)

      const dbAdapter = createDatabaseAdapter<BaseDatabaseAdapter>({
        name: 'payload-remote',
        packageName: 'payload-pg-ch',
        defaultIDType: 'text',
        payload: args.payload,

        connect: async () => {
          await adapter.init()
          const ok = await adapter.checkSchema()
          if (!ok) console.warn('[payload-remote] Schema not ready on remote server')
          await adapter.ensureNamespace(ns)
          console.log(`[payload-remote] Connected to ${config.url} (ns: ${ns})`)
        },

        destroy: async () => {
          await adapter.destroy()
        },

        beginTransaction: async () => null,
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},

        // -- CRUD --

        create: async (cArgs) => {
          const result = await adapter.create({
            ns,
            type: cArgs.collection,
            data: sanitizeData(cArgs.data as Record<string, unknown>),
          })
          const doc = typeof result.doc === 'object' && result.doc !== null
            ? result.doc as Record<string, unknown> : {}
          return toPayloadDoc({ id: result.id, ...doc })
        },

        find: async <T = Record<string, unknown>>(fArgs: { collection: string; where?: Record<string, unknown>; sort?: unknown; page?: number; limit?: number }): Promise<PaginatedDocs<T>> => {
          const page = fArgs.page ?? 1
          const limit = fArgs.limit ?? 10
          const offset = (page - 1) * limit
          const result = await adapter.find({
            ns,
            type: fArgs.collection,
            where: convertWhere(fArgs.where),
            sort: normalizeSort(fArgs.sort),
            limit: limit === 0 ? undefined : limit,
            offset: limit === 0 ? undefined : offset,
          })
          const docs = result.docs.map(d => toPayloadDoc(d) as T)
          return paginate(docs, result.total, page, limit)
        },

        findOne: async <T extends { id: string | number }>(foArgs: { collection: string; where?: Record<string, unknown> }): Promise<T | null> => {
          const idFromWhere = extractIdFromWhere(foArgs.where)
          const result = idFromWhere
            ? await adapter.findOne({ ns, type: foArgs.collection, id: idFromWhere })
            : await adapter.findOne({ ns, type: foArgs.collection, where: convertWhere(foArgs.where) })
          if (!result) return null
          return toPayloadDoc(result) as T
        },

        updateOne: async (uArgs) => {
          let docId: string | undefined
          if ('id' in uArgs && uArgs.id != null) {
            docId = String(uArgs.id)
          } else if ('where' in uArgs && uArgs.where) {
            const idFromWhere = extractIdFromWhere(uArgs.where as Record<string, unknown>)
            if (idFromWhere) {
              docId = idFromWhere
            } else {
              const found = await adapter.findOne({
                ns,
                type: uArgs.collection,
                where: convertWhere(uArgs.where as Record<string, unknown>),
              })
              if (!found) return { id: '' } as Record<string, unknown>
              docId = found.id
            }
          }
          if (!docId) return { id: '' } as Record<string, unknown>
          const result = await adapter.updateOne({
            ns,
            type: uArgs.collection,
            id: docId,
            data: sanitizeData(uArgs.data as Record<string, unknown>),
          })
          const doc = typeof result.doc === 'object' && result.doc !== null
            ? result.doc as Record<string, unknown> : {}
          return toPayloadDoc({ id: result.id, ...doc })
        },

        updateMany: async (umArgs) => {
          const found = await adapter.find({
            ns,
            type: umArgs.collection,
            where: convertWhere(umArgs.where as Record<string, unknown>),
          })
          const results: Record<string, unknown>[] = []
          for (const doc of found.docs) {
            const result = await adapter.updateOne({
              ns, type: umArgs.collection, id: doc.id, data: umArgs.data,
            })
            const d = typeof result.doc === 'object' && result.doc !== null
              ? result.doc as Record<string, unknown> : {}
            results.push(toPayloadDoc({ id: result.id, ...d }))
          }
          return results
        },

        deleteOne: async (dArgs) => {
          const idFromWhere = extractIdFromWhere(dArgs.where as Record<string, unknown>)
          const found = idFromWhere
            ? await adapter.findOne({ ns, type: dArgs.collection, id: idFromWhere })
            : await adapter.findOne({ ns, type: dArgs.collection, where: convertWhere(dArgs.where as Record<string, unknown>) })
          if (!found) return { id: '' } as Record<string, unknown>
          await adapter.deleteMany({
            ns, type: dArgs.collection,
            where: { id: { equals: found.id } },
          })
          return toPayloadDoc(found)
        },

        deleteMany: async (dmArgs) => {
          await adapter.deleteMany({
            ns,
            type: dmArgs.collection,
            where: convertWhere(dmArgs.where as Record<string, unknown>) as InternalWhere,
          })
        },

        count: async (cArgs) => {
          const result = await adapter.find({
            ns, type: cArgs.collection, where: convertWhere(cArgs.where), limit: 0,
          })
          return { totalDocs: result.total }
        },

        upsert: async (usArgs) => {
          const idFromWhere = extractIdFromWhere(usArgs.where as Record<string, unknown>)
          const existing = idFromWhere
            ? await adapter.findOne({ ns, type: usArgs.collection, id: idFromWhere })
            : await adapter.findOne({ ns, type: usArgs.collection, where: convertWhere(usArgs.where as Record<string, unknown>) })
          if (existing) {
            const result = await adapter.updateOne({ ns, type: usArgs.collection, id: existing.id, data: usArgs.data })
            const doc = typeof result.doc === 'object' && result.doc !== null
              ? result.doc as Record<string, unknown> : {}
            return toPayloadDoc({ id: result.id, ...doc })
          }
          const result = await adapter.create({ ns, type: usArgs.collection, data: usArgs.data })
          const doc = typeof result.doc === 'object' && result.doc !== null
            ? result.doc as Record<string, unknown> : {}
          return toPayloadDoc({ id: result.id, ...doc })
        },

        queryDrafts: async <T = Record<string, unknown>>(qdArgs: { collection: string; where?: Record<string, unknown>; sort?: unknown; page?: number; limit?: number }): Promise<PaginatedDocs<T>> => {
          const page = qdArgs.page ?? 1
          const limit = qdArgs.limit ?? 10
          const offset = (page - 1) * limit
          const where = convertWhere(qdArgs.where) ?? {}
          const draftWhere: InternalWhere = {
            ...where,
            and: [...(where.and ?? []), { status: { equals: 'draft' } }],
          }
          const result = await adapter.find({
            ns, type: qdArgs.collection, where: draftWhere,
            sort: normalizeSort(qdArgs.sort), limit, offset,
          })
          const docs = result.docs.map(d => toPayloadDoc(d) as T)
          return paginate(docs, result.total, page, limit)
        },

        // -- Globals --

        createGlobal: async (gArgs) => {
          const result = await adapter.create({
            ns, type: '_globals',
            data: { ...gArgs.data, globalSlug: gArgs.slug, name: gArgs.slug },
          })
          const doc = typeof result.doc === 'object' && result.doc !== null
            ? result.doc as Record<string, unknown> : {}
          return { id: result.id, ...doc } as never
        },

        findGlobal: async (gArgs) => {
          const result = await adapter.findOne({
            ns, type: '_globals', where: { name: { equals: gArgs.slug } },
          })
          if (!result) return {} as never
          return toPayloadDoc(result) as never
        },

        updateGlobal: async (gArgs) => {
          const existing = await adapter.findOne({
            ns, type: '_globals', where: { name: { equals: gArgs.slug } },
          })
          if (existing) {
            const result = await adapter.updateOne({
              ns, type: '_globals', id: existing.id,
              data: { ...gArgs.data, globalSlug: gArgs.slug, name: gArgs.slug },
            })
            const doc = typeof result.doc === 'object' && result.doc !== null
              ? result.doc as Record<string, unknown> : {}
            return toPayloadDoc({ id: result.id, ...doc }) as never
          }
          const result = await adapter.create({
            ns, type: '_globals',
            data: { ...gArgs.data, globalSlug: gArgs.slug, name: gArgs.slug },
          })
          const doc = typeof result.doc === 'object' && result.doc !== null
            ? result.doc as Record<string, unknown> : {}
          return toPayloadDoc({ id: result.id, ...doc }) as never
        },

        // -- Versions --

        createVersion: async (vArgs) => {
          // Mark previous versions as not latest
          const prevVersions = await adapter.find({
            ns, type: `_versions_${vArgs.collectionSlug}`,
            where: { parent: { equals: String(vArgs.parent) }, latest: { equals: true } },
          })
          for (const prev of prevVersions.docs) {
            await adapter.updateOne({
              ns, type: `_versions_${vArgs.collectionSlug}`, id: prev.id, data: { latest: false },
            })
          }
          const result = await adapter.create({
            ns, type: `_versions_${vArgs.collectionSlug}`,
            data: {
              _versionOf: vArgs.collectionSlug,
              parent: String(vArgs.parent),
              version: vArgs.versionData,
              autosave: vArgs.autosave,
              latest: true,
              createdAt: vArgs.createdAt,
              updatedAt: vArgs.updatedAt,
              publishedLocale: vArgs.publishedLocale,
              snapshot: vArgs.snapshot ?? false,
            },
          })
          return {
            id: result.id,
            parent: String(vArgs.parent),
            version: vArgs.versionData,
            createdAt: vArgs.createdAt,
            updatedAt: vArgs.updatedAt,
            latest: true,
            publishedLocale: vArgs.publishedLocale,
            snapshot: vArgs.snapshot,
          }
        },

        findVersions: async <T = unknown>(fvArgs: { collection: string; where?: Record<string, unknown>; sort?: unknown; page?: number; limit?: number }): Promise<PaginatedDocs<any>> => {
          const page = fvArgs.page ?? 1
          const limit = fvArgs.limit ?? 10
          const offset = (page - 1) * limit
          const result = await adapter.find({
            ns, type: `_versions_${fvArgs.collection}`,
            where: convertWhere(fvArgs.where), sort: normalizeSort(fvArgs.sort), limit, offset,
          })
          const docs = result.docs.map(d => ({
            id: d.id,
            parent: (d.parent as string) ?? '',
            version: d.version ?? {},
            createdAt: (d.createdAt as string) ?? (d.created as string) ?? new Date().toISOString(),
            updatedAt: (d.updatedAt as string) ?? (d.updated as string) ?? new Date().toISOString(),
            latest: (d.latest as boolean) ?? false,
            publishedLocale: d.publishedLocale as string | undefined,
            snapshot: (d.snapshot as boolean) ?? false,
          }))
          return paginate(docs, result.total, page, limit)
        },

        updateVersion: async (uvArgs) => {
          let docId: string | undefined
          if ('id' in uvArgs && uvArgs.id != null) {
            docId = String(uvArgs.id)
          } else if ('where' in uvArgs && uvArgs.where) {
            const idFromWhere = extractIdFromWhere(uvArgs.where as Record<string, unknown>)
            if (idFromWhere) {
              docId = idFromWhere
            } else {
              const found = await adapter.findOne({
                ns, type: `_versions_${uvArgs.collection}`,
                where: convertWhere(uvArgs.where as Record<string, unknown>),
              })
              if (found) docId = found.id
            }
          }
          if (!docId) {
            return {
              id: '', parent: '', version: uvArgs.versionData.version,
              createdAt: uvArgs.versionData.createdAt ?? new Date().toISOString(),
              updatedAt: uvArgs.versionData.updatedAt ?? new Date().toISOString(),
            }
          }
          const updateData: Record<string, unknown> = {}
          if (uvArgs.versionData.version !== undefined) updateData.version = uvArgs.versionData.version
          if (uvArgs.versionData.latest !== undefined) updateData.latest = uvArgs.versionData.latest
          if (uvArgs.versionData.parent !== undefined) updateData.parent = String(uvArgs.versionData.parent)
          if (uvArgs.versionData.createdAt !== undefined) updateData.createdAt = uvArgs.versionData.createdAt
          if (uvArgs.versionData.updatedAt !== undefined) updateData.updatedAt = uvArgs.versionData.updatedAt
          if (uvArgs.versionData.publishedLocale !== undefined) updateData.publishedLocale = uvArgs.versionData.publishedLocale
          const result = await adapter.updateOne({
            ns, type: `_versions_${uvArgs.collection}`, id: docId, data: updateData,
          })
          const doc = typeof result.doc === 'object' && result.doc !== null
            ? result.doc as Record<string, unknown> : {}
          return {
            id: result.id,
            parent: (doc.parent as string) ?? '',
            version: doc.version ?? uvArgs.versionData.version,
            createdAt: (doc.createdAt as string) ?? new Date().toISOString(),
            updatedAt: (doc.updatedAt as string) ?? new Date().toISOString(),
            latest: (doc.latest as boolean) ?? false,
            publishedLocale: doc.publishedLocale as string | undefined,
          }
        },

        deleteVersions: async (dvArgs) => {
          const type = dvArgs.collection
            ? `_versions_${dvArgs.collection}`
            : dvArgs.globalSlug
              ? `_versions__globals_${dvArgs.globalSlug}`
              : '_versions'
          await adapter.deleteMany({
            ns, type, where: convertWhere(dvArgs.where as Record<string, unknown>) as InternalWhere,
          })
        },

        countVersions: async (cvArgs) => {
          const result = await adapter.find({
            ns, type: `_versions_${cvArgs.collection}`,
            where: convertWhere(cvArgs.where), limit: 0,
          })
          return { totalDocs: result.total }
        },

        // -- Global Versions --

        createGlobalVersion: async (gvArgs) => {
          const prevVersions = await adapter.find({
            ns, type: `_versions__globals_${gvArgs.globalSlug}`,
            where: { latest: { equals: true } },
          })
          for (const prev of prevVersions.docs) {
            await adapter.updateOne({
              ns, type: `_versions__globals_${gvArgs.globalSlug}`,
              id: prev.id, data: { latest: false },
            })
          }
          const result = await adapter.create({
            ns, type: `_versions__globals_${gvArgs.globalSlug}`,
            data: {
              _versionOfGlobal: gvArgs.globalSlug,
              version: gvArgs.versionData,
              autosave: gvArgs.autosave,
              latest: true,
              createdAt: gvArgs.createdAt,
              updatedAt: gvArgs.updatedAt,
              publishedLocale: gvArgs.publishedLocale,
              snapshot: gvArgs.snapshot ?? false,
            },
          })
          return {
            id: result.id, version: gvArgs.versionData,
            createdAt: gvArgs.createdAt, updatedAt: gvArgs.updatedAt,
            latest: true, publishedLocale: gvArgs.publishedLocale, snapshot: gvArgs.snapshot,
          }
        },

        findGlobalVersions: async <T = unknown>(fgvArgs: { global: string; where?: Record<string, unknown>; sort?: unknown; page?: number; limit?: number }): Promise<PaginatedDocs<any>> => {
          const page = fgvArgs.page ?? 1
          const limit = fgvArgs.limit ?? 10
          const offset = (page - 1) * limit
          const result = await adapter.find({
            ns, type: `_versions__globals_${fgvArgs.global}`,
            where: convertWhere(fgvArgs.where), sort: normalizeSort(fgvArgs.sort), limit, offset,
          })
          const docs = result.docs.map(d => ({
            id: d.id,
            parent: (d.parent as string) ?? '',
            version: d.version ?? {},
            createdAt: (d.createdAt as string) ?? (d.created as string) ?? new Date().toISOString(),
            updatedAt: (d.updatedAt as string) ?? (d.updated as string) ?? new Date().toISOString(),
            latest: (d.latest as boolean) ?? false,
            publishedLocale: d.publishedLocale as string | undefined,
          }))
          return paginate(docs, result.total, page, limit)
        },

        updateGlobalVersion: async (ugvArgs) => {
          let docId: string | undefined
          if ('id' in ugvArgs && ugvArgs.id != null) {
            docId = String(ugvArgs.id)
          } else if ('where' in ugvArgs && ugvArgs.where) {
            const idFromWhere = extractIdFromWhere(ugvArgs.where as Record<string, unknown>)
            if (idFromWhere) {
              docId = idFromWhere
            } else {
              const found = await adapter.findOne({
                ns, type: `_versions__globals_${ugvArgs.global}`,
                where: convertWhere(ugvArgs.where as Record<string, unknown>),
              })
              if (found) docId = found.id
            }
          }
          if (!docId) {
            return {
              id: '', parent: '', version: ugvArgs.versionData.version,
              createdAt: ugvArgs.versionData.createdAt ?? new Date().toISOString(),
              updatedAt: ugvArgs.versionData.updatedAt ?? new Date().toISOString(),
            }
          }
          const updateData: Record<string, unknown> = {}
          if (ugvArgs.versionData.version !== undefined) updateData.version = ugvArgs.versionData.version
          if (ugvArgs.versionData.latest !== undefined) updateData.latest = ugvArgs.versionData.latest
          if (ugvArgs.versionData.createdAt !== undefined) updateData.createdAt = ugvArgs.versionData.createdAt
          if (ugvArgs.versionData.updatedAt !== undefined) updateData.updatedAt = ugvArgs.versionData.updatedAt
          if (ugvArgs.versionData.publishedLocale !== undefined) updateData.publishedLocale = ugvArgs.versionData.publishedLocale
          const result = await adapter.updateOne({
            ns, type: `_versions__globals_${ugvArgs.global}`, id: docId, data: updateData,
          })
          const doc = typeof result.doc === 'object' && result.doc !== null
            ? result.doc as Record<string, unknown> : {}
          return {
            id: result.id,
            parent: (doc.parent as string) ?? '',
            version: doc.version ?? ugvArgs.versionData.version,
            createdAt: (doc.createdAt as string) ?? new Date().toISOString(),
            updatedAt: (doc.updatedAt as string) ?? new Date().toISOString(),
            latest: (doc.latest as boolean) ?? false,
            publishedLocale: doc.publishedLocale as string | undefined,
          }
        },

        countGlobalVersions: async (cgvArgs) => {
          const result = await adapter.find({
            ns, type: `_versions__globals_${cgvArgs.global}`,
            where: convertWhere(cgvArgs.where), limit: 0,
          })
          return { totalDocs: result.total }
        },

        // -- Find Distinct --

        findDistinct: async (fdArgs) => {
          const page = fdArgs.page ?? 1
          const limit = fdArgs.limit ?? 10
          const offset = (page - 1) * limit
          const result = await adapter.findDistinct({
            ns, collection: fdArgs.collection, field: fdArgs.field, limit, offset,
          })
          const totalPages = Math.ceil(result.total / limit) || 1
          return {
            values: result.values,
            totalDocs: result.total,
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

        // -- Jobs --

        updateJobs: async (jArgs) => {
          if ('id' in jArgs && jArgs.id != null) {
            const result = await adapter.updateOne({
              ns, type: 'payload-jobs', id: String(jArgs.id), data: jArgs.data,
            })
            const doc = typeof result.doc === 'object' && result.doc !== null
              ? result.doc as Record<string, unknown> : {}
            return [toPayloadDoc({ id: result.id, ...doc })] as never
          }
          if ('where' in jArgs && jArgs.where) {
            const found = await adapter.find({
              ns, type: 'payload-jobs',
              where: convertWhere(jArgs.where as Record<string, unknown>), limit: jArgs.limit,
            })
            const results = []
            for (const d of found.docs) {
              const result = await adapter.updateOne({
                ns, type: 'payload-jobs', id: d.id, data: jArgs.data,
              })
              const doc = typeof result.doc === 'object' && result.doc !== null
                ? result.doc as Record<string, unknown> : {}
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
