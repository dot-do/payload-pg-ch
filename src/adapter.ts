import type pg from 'pg'
import type {
  Sqid, NsRow, DataRow, RelRow, ActionRow,
  Where, RequestMeta, CollectionTier, FieldSchema, AdapterConfig,
} from './types.js'
import { createPool, transaction, query, type Pool } from './db/pg.js'
import { toSqid, fromSqid, generateRand, registerPrefix } from './id/sqids.js'
import { NsResolver } from './ns/resolver.js'
import { createBranch, mergeBranch } from './ns/branch.js'
import { insertData, updateData, deleteData, findData, findOneData, findDataCOW } from './db/queries/data.js'
import { insertRel, deleteRelsForEntity, findRelsFrom, findRelsTo, extractRels } from './db/queries/rels.js'
import { insertLog, emit } from './db/queries/log.js'
import { insertPending } from './db/queries/pending.js'
import { enqueueAction, dequeueActions, checkpointAction, completeAction, failAction } from './db/queries/actions.js'

const COLLECTION_TIER: Record<string, CollectionTier> = {
  events: 'ch',
  versions: 'ch',
  search: 'ch',
}

interface CollectionDef {
  slug: string
  fields: FieldSchema[]
  prefix?: string
}

export class DocumentAdapter {
  pool: Pool
  nsResolver: NsResolver
  private collections: Map<string, CollectionDef> = new Map()

  constructor(config: AdapterConfig, collections: CollectionDef[] = []) {
    this.pool = createPool(config.postgres)
    this.nsResolver = new NsResolver(this.pool as unknown as pg.Pool)

    // Register custom prefixes
    if (config.collections) {
      for (const [slug, opts] of Object.entries(config.collections)) {
        registerPrefix(slug, opts.prefix)
      }
    }
    for (const col of collections) {
      this.collections.set(col.slug, col)
      if (col.prefix) registerPrefix(col.slug, col.prefix)
    }
  }

  async init(): Promise<void> {
    await this.nsResolver.start()
  }

  async destroy(): Promise<void> {
    this.nsResolver.stop()
    await this.pool.end()
  }

  tier(collection: string): CollectionTier {
    return COLLECTION_TIER[collection] ?? 'pg'
  }

  private getFields(collection: string): FieldSchema[] {
    return this.collections.get(collection)?.fields ?? []
  }

  private rowToSqid(row: DataRow): Sqid {
    const ns = this.nsResolver.getById(row.ns)
    const identity = ns?.githuborgid ?? row.ns
    return toSqid(row.collection, row.id, identity, row.created, row.rand) as Sqid
  }

  // --- CRUD ---

  async create(args: {
    ns: number
    collection: string
    data: Record<string, unknown>
    actor?: number
    meta?: RequestMeta
  }): Promise<{ id: Sqid; doc: unknown }> {
    const rand = generateRand()
    const fields = this.getFields(args.collection)

    return transaction(this.pool as unknown as pg.Pool, async (tx) => {
      const row = await insertData(tx, {
        ns: args.ns,
        collection: args.collection,
        slug: args.data.slug as string | undefined,
        doc: args.data,
        status: args.data.status as string | undefined,
        locale: args.data.locale as string | undefined,
        rand,
      })

      // Extract and insert relationships
      const rels = extractRels(args.data, fields)
      for (const rel of rels) {
        await insertRel(tx, {
          ns: args.ns,
          from: row.id,
          to: rel.to,
          path: rel.path,
          sort: rel.sort,
        })
      }

      // Log entry
      await insertLog(tx, {
        ns: args.ns,
        kind: 'data.created',
        entity: row.id,
        collection: args.collection,
        actor: args.actor,
        doc: args.data,
        meta: args.meta,
        rand,
      })

      // Pending row for search indexing
      await insertPending(tx, {
        ns: args.ns,
        entity: row.id,
        collection: args.collection,
        title: args.data.title as string | undefined,
        body: extractBody(args.data),
      })

      return { id: this.rowToSqid(row), doc: args.data }
    })
  }

  async find(args: {
    ns: number
    collection: string
    where?: Where
    sort?: string
    limit?: number
    offset?: number
  }): Promise<{ docs: Array<{ id: Sqid } & Record<string, unknown>>; total: number }> {
    const ns = this.nsResolver.getById(args.ns)

    const result = ns?.parent
      ? await findDataCOW(this.pool as unknown as pg.Pool, {
          ns: args.ns,
          parent: ns.parent,
          collection: args.collection,
          where: args.where,
          sort: args.sort,
          limit: args.limit,
          offset: args.offset,
        })
      : await findData(this.pool as unknown as pg.Pool, {
          ns: args.ns,
          collection: args.collection,
          where: args.where,
          sort: args.sort,
          limit: args.limit,
          offset: args.offset,
        })

    const docs = await Promise.all(
      result.rows.map(async (row) => {
        const doc = typeof row.doc === 'string' ? JSON.parse(row.doc) : row.doc
        const rels = await fetchRelsWithTargets(this.pool as unknown as pg.Pool, row.id)
        const { _parent: _, ...cleanDoc } = doc as Record<string, unknown>
        return {
          id: this.rowToSqid(row),
          ...cleanDoc,
          ...relsToDoc(rels, this.nsResolver),
        } as { id: Sqid } & Record<string, unknown>
      }),
    )

    return { docs, total: result.total }
  }

  async findOne(args: {
    ns: number
    collection: string
    where?: Where
    id?: string
  }): Promise<({ id: Sqid } & Record<string, unknown>) | null> {
    const ns = this.nsResolver.getById(args.ns)
    let row: DataRow | null = null

    if (args.id) {
      const { id } = fromSqid(args.id)
      // Try the current namespace first
      row = await findOneData(this.pool as unknown as pg.Pool, { ns: args.ns, id })
      // In a branch: if not found by parent id, check for forked doc or fall through to parent
      if (!row && ns?.parent) {
        // Look for a forked doc with _parent pointing to this id
        const forked = await query<DataRow>(
          this.pool as unknown as pg.Pool,
          `SELECT * FROM data WHERE ns = $1 AND doc->>'_parent' = $2 LIMIT 1`,
          [args.ns, String(id)],
        )
        if (forked.rows[0]) {
          row = forked.rows[0]
        } else {
          // Fall through to parent
          row = await findOneData(this.pool as unknown as pg.Pool, { ns: ns.parent, id })
        }
      }
    } else if (args.where) {
      // Use COW path for where queries in branches
      if (ns?.parent) {
        const result = await findDataCOW(this.pool as unknown as pg.Pool, {
          ns: args.ns,
          parent: ns.parent,
          collection: args.collection,
          where: args.where,
          limit: 1,
        })
        row = result.rows[0] ?? null
      } else {
        const result = await findData(this.pool as unknown as pg.Pool, {
          ns: args.ns,
          collection: args.collection,
          where: args.where,
          limit: 1,
        })
        row = result.rows[0] ?? null
      }
    }

    if (!row) return null

    const rawDoc = typeof row.doc === 'string' ? JSON.parse(row.doc) : row.doc
    const { _parent: _, ...doc } = rawDoc as Record<string, unknown>
    const rels = await fetchRelsWithTargets(this.pool as unknown as pg.Pool, row.id)
    return {
      id: this.rowToSqid(row),
      ...doc,
      ...relsToDoc(rels, this.nsResolver),
    }
  }

  async updateOne(args: {
    ns: number
    collection: string
    id: string
    data: Record<string, unknown>
    actor?: number
    meta?: RequestMeta
  }): Promise<{ id: Sqid; doc: unknown }> {
    const { id: intId } = fromSqid(args.id)
    const ns = this.nsResolver.getById(args.ns)
    const fields = this.getFields(args.collection)

    return transaction(this.pool as unknown as pg.Pool, async (tx) => {
      let workingId = intId

      // COW fork if in a branch
      if (ns?.parent) {
        const exists = await findOneData(tx, { ns: args.ns, id: intId })
        if (!exists) {
          const parentDoc = await findOneData(tx, { ns: ns.parent, id: intId })
          if (parentDoc) {
            const parentDocObj = typeof parentDoc.doc === 'string' ? JSON.parse(parentDoc.doc) : parentDoc.doc
            const forkedDoc = { ...parentDocObj, _parent: parentDoc.id }
            const forked = await insertData(tx, {
              ns: args.ns,
              collection: parentDoc.collection,
              slug: parentDoc.slug,
              doc: forkedDoc,
              status: parentDoc.status,
              locale: parentDoc.locale,
              rand: parentDoc.rand,
            })
            workingId = forked.id
          }
        }
      }

      // Merge existing doc with updates
      const current = await findOneData(tx, { ns: args.ns, id: workingId })
      const currentDoc = current ? (typeof current.doc === 'string' ? JSON.parse(current.doc) : current.doc) : {}
      const merged = { ...currentDoc, ...args.data }

      const row = await updateData(tx, {
        ns: args.ns,
        id: workingId,
        doc: merged,
        status: args.data.status as string | undefined,
        locale: args.data.locale as string | undefined,
      })

      // Rebuild relationships
      await deleteRelsForEntity(tx, { ns: args.ns, from: workingId })
      const rels = extractRels(merged, fields)
      for (const rel of rels) {
        await insertRel(tx, {
          ns: args.ns,
          from: workingId,
          to: rel.to,
          path: rel.path,
          sort: rel.sort,
        })
      }

      // Log
      await insertLog(tx, {
        ns: args.ns,
        kind: 'data.updated',
        entity: workingId,
        collection: args.collection,
        actor: args.actor,
        doc: merged,
        diff: args.data,
        meta: args.meta,
        rand: row.rand,
      })

      // Pending for search reindex
      await insertPending(tx, {
        ns: args.ns,
        entity: workingId,
        collection: args.collection,
        title: merged.title as string | undefined,
        body: extractBody(merged),
      })

      const { _parent: _, ...cleanMerged } = merged
      return { id: this.rowToSqid(row), doc: cleanMerged }
    })
  }

  async deleteMany(args: {
    ns: number
    collection: string
    where: Where
    actor?: number
    meta?: RequestMeta
  }): Promise<{ deleted: number }> {
    const ns = this.nsResolver.getById(args.ns)

    return transaction(this.pool as unknown as pg.Pool, async (tx) => {
      // Use COW read path if in a branch, so we see parent docs too
      const result = ns?.parent
        ? await findDataCOW(tx, {
            ns: args.ns,
            parent: ns.parent,
            collection: args.collection,
            where: args.where,
          })
        : await findData(tx, {
            ns: args.ns,
            collection: args.collection,
            where: args.where,
          })

      let deleted = 0
      for (const row of result.rows) {
        if (ns?.parent) {
          // In a branch: write tombstone referencing the parent doc's id
          await insertData(tx, {
            ns: args.ns,
            collection: '_tombstone',
            doc: { _parent: row.id, _deleted: true },
            rand: 0,
          })
        } else {
          await deleteData(tx, { ns: args.ns, id: row.id })
        }

        await insertLog(tx, {
          ns: args.ns,
          kind: 'data.deleted',
          entity: row.id,
          collection: args.collection,
          actor: args.actor,
          meta: args.meta,
          rand: row.rand,
        })
        deleted++
      }

      return { deleted }
    })
  }

  // --- Relationships ---

  async relate(args: {
    ns: number
    from: string
    to: string
    path: string
    sort?: number
  }): Promise<Sqid> {
    const fromDecoded = fromSqid(args.from)
    const toDecoded = fromSqid(args.to)

    return transaction(this.pool as unknown as pg.Pool, async (tx) => {
      const rel = await insertRel(tx, {
        ns: args.ns,
        from: fromDecoded.id,
        to: toDecoded.id,
        path: args.path,
        sort: args.sort,
      })
      return `rel_${rel.id}` as Sqid
    })
  }

  async related(args: {
    id: string
    path?: string
    direction?: 'from' | 'to'
  }): Promise<Array<{ id: Sqid; path: string }>> {
    const { id } = fromSqid(args.id)
    const dir = args.direction ?? 'from'

    const rels = dir === 'from'
      ? await findRelsFrom(this.pool as unknown as pg.Pool, { from: id, path: args.path })
      : await findRelsTo(this.pool as unknown as pg.Pool, { to: id })

    const results: Array<{ id: Sqid; path: string }> = []
    for (const rel of rels) {
      const targetId = dir === 'from' ? rel.to : rel.from
      const target = await findOneData(this.pool as unknown as pg.Pool, { ns: rel.ns, id: targetId })
      if (target) {
        results.push({ id: this.rowToSqid(target), path: rel.path })
      }
    }
    return results
  }

  // --- Durable Execution ---

  async enqueue(args: {
    ns: number
    kind: string
    name: string
    input?: unknown
    entity?: string
    scheduled?: Date
  }): Promise<Sqid> {
    const entityId = args.entity ? fromSqid(args.entity).id : undefined

    return transaction(this.pool as unknown as pg.Pool, async (tx) => {
      const action = await enqueueAction(tx, {
        ns: args.ns,
        kind: args.kind,
        name: args.name,
        input: args.input,
        entity: entityId,
        scheduled: args.scheduled,
      })

      const ns = this.nsResolver.getById(args.ns)
      const identity = ns?.githuborgid ?? args.ns
      return toSqid('actions', action.id, identity, action.created, action.rand) as Sqid
    })
  }

  async dequeue(args: { ns: number; kind?: string; limit?: number }): Promise<ActionRow[]> {
    return transaction(this.pool as unknown as pg.Pool, async (tx) => {
      return dequeueActions(tx, args)
    })
  }

  async checkpoint(args: { id: string; step: number; result: unknown }): Promise<void> {
    const { id } = fromSqid(args.id)
    return transaction(this.pool as unknown as pg.Pool, async (tx) => {
      await checkpointAction(tx, { id, step: args.step, result: args.result })
    })
  }

  async complete(args: { id: string; output?: unknown }): Promise<void> {
    const { id } = fromSqid(args.id)
    await completeAction(this.pool as unknown as pg.Pool, { id, output: args.output })
  }

  async fail(args: { id: string; error: unknown }): Promise<void> {
    const { id } = fromSqid(args.id)
    await failAction(this.pool as unknown as pg.Pool, { id, error: args.error })
  }

  // --- Events ---

  async emit(args: {
    ns: number
    kind: string
    entity?: number
    actor?: number
    meta?: unknown
  }): Promise<void> {
    await emit(this.pool as unknown as pg.Pool, args)
  }

  // --- Search ---

  async search(args: {
    ns: number
    query: string
    collection?: string
    limit?: number
  }): Promise<{ docs: Array<{ id: Sqid }>; scores: number[] }> {
    // Delegates to PG view over ClickHouse search table
    const conditions = ['ns = $1']
    const params: unknown[] = [args.ns]
    let paramIdx = 2

    if (args.collection) {
      conditions.push(`collection = $${paramIdx++}`)
      params.push(args.collection)
    }

    conditions.push(`(title ILIKE $${paramIdx} OR body ILIKE $${paramIdx})`)
    params.push(`%${args.query}%`)
    paramIdx++

    const limit = args.limit ?? 10
    params.push(limit)

    const sql = `
      SELECT entity, collection, ns FROM search_view
      WHERE ${conditions.join(' AND ')}
      LIMIT $${paramIdx}
    `

    const result = await query<{ entity: number; collection: string; ns: number }>(
      this.pool as unknown as pg.Pool, sql, params,
    )

    const docs = result.rows.map(row => {
      const nsRow = this.nsResolver.getById(row.ns)
      const identity = nsRow?.githuborgid ?? row.ns
      return {
        id: toSqid(row.collection, row.entity, identity, new Date(), 0) as Sqid,
      }
    })

    return { docs, scores: result.rows.map(() => 1) }
  }

  async findSimilar(args: {
    ns: number
    collection?: string
    embedding: number[]
    limit?: number
  }): Promise<{ docs: Array<{ id: Sqid }>; scores: number[] }> {
    const conditions = ['ns = $1']
    const params: unknown[] = [args.ns]
    let paramIdx = 2

    if (args.collection) {
      conditions.push(`collection = $${paramIdx++}`)
      params.push(args.collection)
    }

    params.push(`[${args.embedding.join(',')}]`)
    const embParam = `$${paramIdx++}`
    const limit = args.limit ?? 10
    params.push(limit)

    const sql = `
      SELECT id, ns, collection, rand, created, embedding <=> ${embParam}::vector AS score
      FROM data
      WHERE ${conditions.join(' AND ')} AND embedding IS NOT NULL
      ORDER BY score ASC
      LIMIT $${paramIdx}
    `

    const result = await query<DataRow & { score: number }>(
      this.pool as unknown as pg.Pool, sql, params,
    )

    return {
      docs: result.rows.map(row => ({ id: this.rowToSqid(row) })),
      scores: result.rows.map(r => r.score),
    }
  }

  // --- Namespace ---

  async resolveNs(req: { headers: { host?: string }; url?: string }): Promise<NsRow | null> {
    return this.nsResolver.resolveFromRequest(req)
  }

  async createBranch(args: {
    parent: number
    uri: string
    branch?: string
    kind?: string
    ttl?: string
    pr?: number
  }): Promise<NsRow> {
    const parentNs = this.nsResolver.getById(args.parent)
    const ns = await createBranch(this.pool as unknown as pg.Pool, {
      ...args,
      repo: parentNs?.repo ?? undefined,
      root: parentNs?.root ?? '/',
      githuborgid: parentNs?.githuborgid,
    })
    await this.nsResolver.refresh()
    return ns
  }

  async mergeBranch(branchNs: number): Promise<{ merged: number; deleted: number }> {
    const result = await mergeBranch(this.pool as unknown as pg.Pool, branchNs)
    await this.nsResolver.refresh()
    return result
  }
}

// --- Helpers ---

function extractBody(doc: Record<string, unknown>): string | undefined {
  const parts: string[] = []
  if (typeof doc.title === 'string') parts.push(doc.title)
  if (typeof doc.description === 'string') parts.push(doc.description)
  if (typeof doc.content === 'string') parts.push(doc.content)
  if (typeof doc.body === 'string') parts.push(doc.body)
  return parts.length > 0 ? parts.join('\n') : undefined
}

interface RelWithTarget extends RelRow {
  targetCollection: string
  targetCreated: Date
  targetRand: number
  targetNs: number
}

async function fetchRelsWithTargets(
  pool: pg.Pool,
  fromId: number,
): Promise<RelWithTarget[]> {
  const result = await query<RelWithTarget>(
    pool,
    `SELECT r.*, d.collection AS "targetCollection", d.created AS "targetCreated",
            d.rand AS "targetRand", d.ns AS "targetNs"
     FROM rels r
     JOIN data d ON d.id = r."to"
     WHERE r."from" = $1
     ORDER BY r.path, r.sort`,
    [fromId],
  )
  return result.rows
}

function relsToDoc(
  rels: RelWithTarget[],
  nsResolver: NsResolver,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const grouped = new Map<string, RelWithTarget[]>()

  for (const rel of rels) {
    const basePath = rel.path.replace(/\.\d+$/, '')
    if (!grouped.has(basePath)) grouped.set(basePath, [])
    grouped.get(basePath)!.push(rel)
  }

  for (const [path, pathRels] of grouped) {
    if (pathRels.length === 1 && !pathRels[0].path.match(/\.\d+$/)) {
      const r = pathRels[0]
      const nsRow = nsResolver.getById(r.targetNs)
      const identity = nsRow?.githuborgid ?? r.targetNs
      result[path] = toSqid(r.targetCollection, r.to, identity, r.targetCreated, r.targetRand)
    } else {
      result[path] = pathRels
        .sort((a, b) => a.sort - b.sort)
        .map(r => {
          const nsRow = nsResolver.getById(r.targetNs)
          const identity = nsRow?.githuborgid ?? r.targetNs
          return toSqid(r.targetCollection, r.to, identity, r.targetCreated, r.targetRand)
        })
    }
  }

  return result
}
