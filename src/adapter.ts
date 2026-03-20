import type {
  Sqid, NsRow, DataRow, RelRow, ActionRow,
  Where, RequestMeta, CollectionTier, FieldSchema, AdapterConfig,
} from './types.js'
import { createPool, transaction, query, type PgPool } from './db/pg.js'
import { toSqid, fromSqid, generateRand, registerPrefix } from './id/sqids.js'
import { NsResolver } from './ns/resolver.js'
import { createBranch, mergeBranch } from './ns/branch.js'
import { insertData, updateData, deleteData, findData, findOneData, findDataCOW } from './db/queries/data.js'
import { insertRel, deleteRelsForEntity, findRelsFrom, findRelsTo, extractRels } from './db/queries/rels.js'
import { insertLog, emit } from './db/queries/log.js'
import { insertPending } from './db/queries/pending.js'
import { enqueueAction, dequeueActions, checkpointAction, completeAction, failAction, findAction } from './db/queries/actions.js'

const COLLECTION_TIER: Record<string, CollectionTier> = {
  events: 'ch',
  versions: 'ch',
  search: 'ch',
}

// Collections backed by the `actions` table instead of `data`
const ACTIONS_COLLECTIONS = new Set(['agent-runs'])

// Collections that emit version.created log entries on update
const VERSIONED_COLLECTIONS = new Set([
  'nouns', 'documents', 'agents', 'prompts', 'tools', 'functions',
  'workflows', 'components', 'budget-policies',
])

interface CollectionDef {
  slug: string
  fields: FieldSchema[]
  prefix?: string
  versioned?: boolean
}

export class DocumentAdapter {
  pool: PgPool
  nsResolver: NsResolver
  private collections: Map<string, CollectionDef> = new Map()

  constructor(config: AdapterConfig, collections: CollectionDef[] = []) {
    this.pool = createPool(config.postgres)
    this.nsResolver = new NsResolver(this.pool)

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

  async loadDynamicCollections(ns: number): Promise<number> {
    const result = await query<{ doc: Record<string, unknown> }>(
      this.pool,
      `SELECT doc FROM data WHERE ns = $1 AND collection = 'nouns' AND doc->>'schema' IS NOT NULL`,
      [ns],
    )

    let loaded = 0
    for (const row of result.rows) {
      const doc = row.doc
      const slug = doc.slug as string
      const schema = doc.schema as { fields: Array<{ name: string; type: string; [k: string]: unknown }> }
      if (!slug || !schema?.fields) continue

      // Register the dynamic collection with a derived prefix
      const prefix = slug.slice(0, 3)
      registerPrefix(slug, prefix)
      this.collections.set(slug, {
        slug,
        prefix,
        fields: schema.fields.map(f => ({
          name: f.name,
          type: f.type,
          relationTo: f.relationTo as string | string[] | undefined,
          hasMany: f.hasMany as boolean | undefined,
          fields: f.fields as FieldSchema[] | undefined,
        })),
      })
      loaded++
    }
    return loaded
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
    // Route actions-backed collections to the actions table
    if (ACTIONS_COLLECTIONS.has(args.collection)) {
      return this.createAction(args)
    }

    const rand = generateRand()
    const fields = this.getFields(args.collection)

    return transaction(this.pool, async (tx) => {
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

  private async createAction(args: {
    ns: number
    collection: string
    data: Record<string, unknown>
    actor?: number
    meta?: RequestMeta
  }): Promise<{ id: Sqid; doc: unknown }> {
    return transaction(this.pool, async (tx) => {
      const action = await enqueueAction(tx, {
        ns: args.ns,
        kind: args.data.kind as string ?? args.collection,
        name: args.data.name as string ?? '',
        input: args.data.input ?? args.data,
        entity: args.data.entity as number | undefined,
        scheduled: args.data.scheduled as Date | undefined,
      })

      const nsRow = this.nsResolver.getById(args.ns)
      const identity = nsRow?.githuborgid ?? args.ns
      return {
        id: toSqid(args.collection, action.id, identity, action.created, action.rand) as Sqid,
        doc: args.data,
      }
    })
  }

  private async findActions(args: {
    ns: number
    collection: string
    where?: Where
    limit?: number
    offset?: number
  }): Promise<{ docs: Array<{ id: Sqid } & Record<string, unknown>>; total: number }> {
    const kind = args.collection === 'agent-runs' ? 'agent-run' : args.collection
    const conditions = ['ns = $1', 'kind = $2']
    const params: unknown[] = [args.ns, kind]
    let paramIdx = 3

    // Support basic status filtering from where clause
    const statusFilter = args.where?.status as { equals?: string } | undefined
    if (statusFilter?.equals) {
      conditions.push(`status = $${paramIdx++}`)
      params.push(statusFilter.equals)
    }

    params.push(args.limit ?? 100, args.offset ?? 0)
    const sql = `SELECT *, count(*) OVER() AS total FROM actions
       WHERE ${conditions.join(' AND ')}
       ORDER BY created DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`

    const result = await query<ActionRow & { total: string }>(
      this.pool,
      sql,
      params,
    )

    const nsRow = this.nsResolver.getById(args.ns)
    const identity = nsRow?.githuborgid ?? args.ns
    const total = result.rows.length > 0 ? parseInt(result.rows[0].total, 10) : 0

    return {
      docs: result.rows.map(row => ({
        id: toSqid(args.collection, row.id, identity, row.created, row.rand) as Sqid,
        kind: row.kind,
        name: row.name,
        status: row.status,
        input: row.input,
        output: row.output,
        steps: row.steps,
        created: row.created,
      })),
      total,
    }
  }

  private async findOneAction(args: {
    ns: number
    collection: string
    id: string
  }): Promise<({ id: Sqid } & Record<string, unknown>) | null> {
    const { id } = fromSqid(args.id)
    const action = await findAction(this.pool, id, args.ns)
    if (!action) return null

    const nsRow = this.nsResolver.getById(args.ns)
    const identity = nsRow?.githuborgid ?? args.ns
    return {
      id: toSqid(args.collection, action.id, identity, action.created, action.rand) as Sqid,
      kind: action.kind,
      name: action.name,
      status: action.status,
      input: action.input,
      output: action.output,
      steps: action.steps,
      created: action.created,
    }
  }

  async find(args: {
    ns: number
    collection: string
    where?: Where
    sort?: string
    limit?: number
    offset?: number
  }): Promise<{ docs: Array<{ id: Sqid } & Record<string, unknown>>; total: number }> {
    // Route actions-backed collections
    if (ACTIONS_COLLECTIONS.has(args.collection)) {
      return this.findActions(args)
    }

    const ns = this.nsResolver.getById(args.ns)

    const result = ns?.parent
      ? await findDataCOW(this.pool, {
          ns: args.ns,
          parent: ns.parent,
          collection: args.collection,
          where: args.where,
          sort: args.sort,
          limit: args.limit,
          offset: args.offset,
        })
      : await findData(this.pool, {
          ns: args.ns,
          collection: args.collection,
          where: args.where,
          sort: args.sort,
          limit: args.limit,
          offset: args.offset,
        })

    const fromIds = result.rows.map(row => row.id)
    const relsMap = await batchFetchRelsWithTargets(this.pool, fromIds, args.ns)

    const docs = result.rows.map((row) => {
      const doc = typeof row.doc === 'string' ? JSON.parse(row.doc) : row.doc
      const rels = relsMap.get(row.id) ?? []
      const { _parent: _, ...cleanDoc } = doc as Record<string, unknown>
      return {
        id: this.rowToSqid(row),
        ...cleanDoc,
        ...relsToDoc(rels, this.nsResolver),
      } as { id: Sqid } & Record<string, unknown>
    })

    return { docs, total: result.total }
  }

  async findOne(args: {
    ns: number
    collection: string
    where?: Where
    id?: string
  }): Promise<({ id: Sqid } & Record<string, unknown>) | null> {
    // Route actions-backed collections to the actions table
    if (ACTIONS_COLLECTIONS.has(args.collection) && args.id) {
      return this.findOneAction(args as { ns: number; collection: string; id: string })
    }

    const ns = this.nsResolver.getById(args.ns)
    let row: DataRow | null = null

    if (args.id) {
      const { id } = fromSqid(args.id)
      // Try the current namespace first
      row = await findOneData(this.pool, { ns: args.ns, id })
      // In a branch: if not found by parent id, check for forked doc or fall through to parent
      if (!row && ns?.parent) {
        // Check if doc is tombstoned in this branch
        const tombstone = await query<{ hidden: number }>(
          this.pool,
          `SELECT 1 AS hidden FROM data WHERE ns = $1 AND collection = '_tombstone' AND (doc->>'_parent')::bigint = $2`,
          [args.ns, id],
        )
        if (tombstone.rows.length > 0) {
          // Doc was deleted in this branch — return null
          row = null
        } else {
          // Look for a forked doc with _parent pointing to this id
          const forked = await query<DataRow>(
            this.pool,
            `SELECT * FROM data WHERE ns = $1 AND doc->>'_parent' = $2 LIMIT 1`,
            [args.ns, String(id)],
          )
          if (forked.rows[0]) {
            row = forked.rows[0]
          } else {
            // Fall through to parent
            row = await findOneData(this.pool, { ns: ns.parent, id })
          }
        }
      }
    } else if (args.where) {
      // Use COW path for where queries in branches
      if (ns?.parent) {
        const result = await findDataCOW(this.pool, {
          ns: args.ns,
          parent: ns.parent,
          collection: args.collection,
          where: args.where,
          limit: 1,
        })
        row = result.rows[0] ?? null
      } else {
        const result = await findData(this.pool, {
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
    const rels = await fetchRelsWithTargets(this.pool, row.id, args.ns)
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

    return transaction(this.pool, async (tx) => {
      let workingId = intId

      // COW fork if in a branch
      if (ns?.parent) {
        let exists = await findOneData(tx, { ns: args.ns, id: intId })
        if (!exists) {
          // Check if we already forked this doc (forked doc has _parent = intId)
          const forkedResult = await query<DataRow>(
            tx,
            `SELECT * FROM data WHERE ns = $1 AND doc->>'_parent' = $2 LIMIT 1`,
            [args.ns, String(intId)],
          )
          if (forkedResult.rows[0]) {
            exists = forkedResult.rows[0]
            workingId = exists.id
          }
        }
        if (!exists) {
          const parentDoc = await findOneData(tx, { ns: ns.parent, id: intId })
          if (parentDoc) {
            const parentDocObj = typeof parentDoc.doc === 'string' ? JSON.parse(parentDoc.doc) : parentDoc.doc
            const forkedDoc = { ...parentDocObj, _parent: parentDoc.id }
            const forkedRow = await insertData(tx, {
              ns: args.ns,
              collection: parentDoc.collection,
              slug: parentDoc.slug,
              doc: forkedDoc,
              status: parentDoc.status,
              locale: parentDoc.locale,
              rand: parentDoc.rand,
            })
            workingId = forkedRow.id
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

      // Version log for versioned collections
      if (VERSIONED_COLLECTIONS.has(args.collection)) {
        await insertLog(tx, {
          ns: args.ns,
          kind: 'version.created',
          entity: workingId,
          collection: args.collection,
          actor: args.actor,
          doc: merged,
          meta: args.meta,
          rand: row.rand,
        })
      }

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

    return transaction(this.pool, async (tx) => {
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
          const rowDoc = typeof row.doc === 'string' ? JSON.parse(row.doc) : row.doc
          const hasParent = rowDoc && typeof rowDoc === 'object' && '_parent' in rowDoc
          if (row.ns === args.ns && !hasParent) {
            // Branch-created doc (no _parent): delete the actual row
            await deleteData(tx, { ns: args.ns, id: row.id })
          } else {
            // Inherited from parent: write tombstone
            await insertData(tx, {
              ns: args.ns,
              collection: '_tombstone',
              doc: { _parent: row.id, _deleted: true },
              rand: 0,
            })
          }
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

        // Pending row for search de-indexing
        await insertPending(tx, {
          ns: args.ns,
          entity: row.id,
          collection: args.collection,
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

    return transaction(this.pool, async (tx) => {
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
    ns?: number
    id: string
    path?: string
    direction?: 'from' | 'to'
  }): Promise<Array<{ id: Sqid; path: string }>> {
    const { id } = fromSqid(args.id)
    const dir = args.direction ?? 'from'

    const rels = dir === 'from'
      ? await findRelsFrom(this.pool, { from: id, path: args.path, ns: args.ns })
      : await findRelsTo(this.pool, { to: id, ns: args.ns })

    const results: Array<{ id: Sqid; path: string }> = []
    for (const rel of rels) {
      const targetId = dir === 'from' ? rel.to : rel.from
      const target = await findOneData(this.pool, { ns: rel.ns, id: targetId })
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

    return transaction(this.pool, async (tx) => {
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
    return transaction(this.pool, async (tx) => {
      return dequeueActions(tx, args)
    })
  }

  async checkpoint(args: { id: string; step: number; result: unknown }): Promise<void> {
    const { id } = fromSqid(args.id)
    return transaction(this.pool, async (tx) => {
      await checkpointAction(tx, { id, step: args.step, result: args.result })
    })
  }

  async complete(args: { id: string; output?: unknown }): Promise<void> {
    const { id } = fromSqid(args.id)
    await completeAction(this.pool, { id, output: args.output })
  }

  async fail(args: { id: string; error: unknown }): Promise<void> {
    const { id } = fromSqid(args.id)
    await failAction(this.pool, { id, error: args.error })
  }

  // --- Events ---

  async emit(args: {
    ns: number
    kind: string
    entity?: number
    actor?: number
    meta?: unknown
  }): Promise<void> {
    await emit(this.pool, args)
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
      this.pool, sql, params,
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
      this.pool, sql, params,
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
    const ns = await createBranch(this.pool, {
      ...args,
      repo: parentNs?.repo ?? undefined,
      root: parentNs?.root ?? '/',
      githuborgid: parentNs?.githuborgid,
    })
    await this.nsResolver.refresh()
    return ns
  }

  async mergeBranch(branchNs: number): Promise<{ merged: number; deleted: number }> {
    const result = await mergeBranch(this.pool, branchNs)
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
  pool: PgPool,
  fromId: number,
  ns?: number,
): Promise<RelWithTarget[]> {
  if (ns !== undefined) {
    const result = await query<RelWithTarget>(
      pool,
      `SELECT r.*, d.collection AS "targetCollection", d.created AS "targetCreated",
              d.rand AS "targetRand", d.ns AS "targetNs"
       FROM rels r
       JOIN data d ON d.id = r."to"
       WHERE r."from" = $1 AND r.ns = $2
       ORDER BY r.path, r.sort`,
      [fromId, ns],
    )
    return result.rows
  }
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

async function batchFetchRelsWithTargets(
  pool: PgPool,
  fromIds: number[],
  ns?: number,
): Promise<Map<number, RelWithTarget[]>> {
  const map = new Map<number, RelWithTarget[]>()
  if (fromIds.length === 0) return map

  const result = ns !== undefined
    ? await query<RelWithTarget>(
        pool,
        `SELECT r.*, d.collection AS "targetCollection", d.created AS "targetCreated",
                d.rand AS "targetRand", d.ns AS "targetNs"
         FROM rels r
         JOIN data d ON d.id = r."to"
         WHERE r."from" = ANY($1) AND r.ns = $2
         ORDER BY r."from", r.path, r.sort`,
        [fromIds, ns],
      )
    : await query<RelWithTarget>(
        pool,
        `SELECT r.*, d.collection AS "targetCollection", d.created AS "targetCreated",
                d.rand AS "targetRand", d.ns AS "targetNs"
         FROM rels r
         JOIN data d ON d.id = r."to"
         WHERE r."from" = ANY($1)
         ORDER BY r."from", r.path, r.sort`,
        [fromIds],
      )

  for (const row of result.rows) {
    const list = map.get(row.from)
    if (list) {
      list.push(row)
    } else {
      map.set(row.from, [row])
    }
  }

  return map
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
