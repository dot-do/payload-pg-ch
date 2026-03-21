import type {
  Sqid, DataRow, RelRow, ActionRow,
  Where, RequestMeta, CollectionTier, FieldSchema, AdapterConfig,
} from './types.js'
import { createPool, transaction, query, type PgPool } from './db/pg.js'
import { toSqid, fromSqid, generateRand, registerPrefix } from './id/sqids.js'
import { NsResolver } from './ns/resolver.js'
import { createBranch, mergeBranch } from './ns/branch.js'
import { insertData, updateData, deleteData, findData, findOneData, findDataCOW } from './db/queries/data.js'
import { insertRel, deleteRelsForEntity, findRelsFrom, findRelsTo, extractRels } from './db/queries/rels.js'
import { emit } from './db/queries/events.js'
import { enqueueAction, dequeueActions, checkpointAction, completeAction, failAction, findAction } from './db/queries/actions.js'

const COLLECTION_TIER: Record<string, CollectionTier> = {
  events: 'ch',
  versions: 'ch',
  search: 'ch',
}

// Types backed by the `actions` table instead of `data`
const ACTIONS_COLLECTIONS = new Set(['agent-runs'])


interface CollectionDef {
  slug: string
  fields: FieldSchema[]
  prefix?: string
  versioned?: boolean
}

export class DocumentAdapter {
  pool: PgPool
  nsResolver: NsResolver
  readonly defaultNs: string
  private collections: Map<string, CollectionDef> = new Map()

  constructor(config: AdapterConfig, collections: CollectionDef[] = []) {
    this.pool = createPool(config.postgres)
    this.nsResolver = new NsResolver(this.pool)
    this.defaultNs = config.ns ?? 'localhost'

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

  async loadDynamicCollections(ns: string): Promise<number> {
    const result = await query<{ data: Record<string, unknown> }>(
      this.pool,
      `SELECT data FROM data WHERE ns = $1 AND type = 'nouns' AND data->>'schema' IS NOT NULL`,
      [ns],
    )

    let loaded = 0
    for (const row of result.rows) {
      const doc = row.data
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

  tier(type: string): CollectionTier {
    return COLLECTION_TIER[type] ?? 'pg'
  }

  private getFields(type: string): FieldSchema[] {
    return this.collections.get(type)?.fields ?? []
  }

  private rowToSqid(row: DataRow): Sqid {
    return toSqid(row.type, row.seq, row.ns, row.created, row.rand) as Sqid
  }

  // --- CRUD ---

  async create(args: {
    ns: string
    type: string
    data: Record<string, unknown>
    actor?: number
    meta?: RequestMeta
  }): Promise<{ id: Sqid; doc: unknown }> {
    // Route actions-backed types to the actions table
    if (ACTIONS_COLLECTIONS.has(args.type)) {
      return this.createAction(args)
    }

    const rand = generateRand()
    const fields = this.getFields(args.type)
    const { doc, meta } = splitMeta(args.data)

    // Promote name from data
    const name = (doc.name as string) ?? (doc.title as string) ?? null

    return transaction(this.pool, async (tx) => {
      const row = await insertData(tx, {
        ns: args.ns,
        type: args.type,
        id: `_tmp_${rand}`,
        name,
        slug: doc.slug as string | undefined,
        url: buildUrl(args.ns, args.type, (doc.slug as string) ?? undefined),
        data: doc,
        mdx: doc.mdx as string | undefined,
        code: doc.code as string | undefined,
        meta: Object.keys(meta).length > 0 ? meta : undefined,
        status: doc.status as string | undefined,
        locale: doc.locale as string | undefined,
        rand,
      })

      // Now that we have the seq, generate the sqid and set it as the id
      const sqid = toSqid(args.type, row.seq, args.ns, row.created, row.rand)

      // Update the id column with the sqid if it was not pre-set
      if (!row.id) {
        await query(tx, `UPDATE data SET id = $1 WHERE seq = $2`, [sqid, row.seq])
        row.id = sqid
      }

      // Also update url if it was built with a placeholder
      if (!row.url) {
        const url = buildUrl(args.ns, args.type, (doc.slug as string) ?? row.id)
        await query(tx, `UPDATE data SET url = $1 WHERE seq = $2`, [url, row.seq])
      }

      // Extract and insert relationships
      const rels = extractRels(doc as Record<string, unknown>, fields)
      for (const rel of rels) {
        await insertRel(tx, {
          ns: args.ns,
          from: row.seq,
          to: rel.to,
          path: rel.path,
          sort: rel.sort,
        })
      }

      return { id: this.rowToSqid(row), doc: args.data }
    })
  }

  private async createAction(args: {
    ns: string
    type: string
    data: Record<string, unknown>
    actor?: number
    meta?: RequestMeta
  }): Promise<{ id: Sqid; doc: unknown }> {
    const rand = generateRand()
    return transaction(this.pool, async (tx) => {
      // Generate a temporary id, will be replaced with sqid
      const action = await enqueueAction(tx, {
        ns: args.ns,
        id: '', // placeholder
        type: args.data.type as string ?? args.type,
        name: args.data.name as string ?? '',
        input: args.data.input ?? args.data,
        entity: args.data.entity as number | undefined,
        scheduled: args.data.scheduled as Date | undefined,
        rand,
      })

      const sqid = toSqid(args.type, action.seq, args.ns, action.created, action.rand)
      // Update the id column with the sqid
      await query(tx, `UPDATE actions SET id = $1 WHERE seq = $2`, [sqid, action.seq])

      return {
        id: sqid as Sqid,
        doc: args.data,
      }
    })
  }

  private async findActions(args: {
    ns: string
    type: string
    where?: Where
    limit?: number
    offset?: number
  }): Promise<{ docs: Array<{ id: Sqid } & Record<string, unknown>>; total: number }> {
    const actionType = args.type === 'agent-runs' ? 'agent-run' : args.type
    const conditions = ['ns = $1', 'type = $2']
    const params: unknown[] = [args.ns, actionType]
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

    const total = result.rows.length > 0 ? parseInt(result.rows[0].total, 10) : 0

    return {
      docs: result.rows.map(row => ({
        id: toSqid(args.type, row.seq, args.ns, row.created, row.rand) as Sqid,
        type: row.type,
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
    ns: string
    type: string
    id: string
  }): Promise<({ id: Sqid } & Record<string, unknown>) | null> {
    const { seq } = fromSqid(args.id)
    const action = await findAction(this.pool, seq, args.ns)
    if (!action) return null

    return {
      id: toSqid(args.type, action.seq, args.ns, action.created, action.rand) as Sqid,
      type: action.type,
      name: action.name,
      status: action.status,
      input: action.input,
      output: action.output,
      steps: action.steps,
      created: action.created,
    }
  }

  async find(args: {
    ns: string
    type: string
    where?: Where
    sort?: string
    limit?: number
    offset?: number
  }): Promise<{ docs: Array<{ id: Sqid } & Record<string, unknown>>; total: number }> {
    // Route actions-backed types
    if (ACTIONS_COLLECTIONS.has(args.type)) {
      return this.findActions(args)
    }

    const nsDoc = this.nsResolver.getByNs(args.ns)
    const parentNs = this.nsResolver.getParentNs(args.ns)

    const result = parentNs
      ? await findDataCOW(this.pool, {
          ns: args.ns,
          parent: parentNs,
          type: args.type,
          where: args.where,
          sort: args.sort,
          limit: args.limit,
          offset: args.offset,
        })
      : await findData(this.pool, {
          ns: args.ns,
          type: args.type,
          where: args.where,
          sort: args.sort,
          limit: args.limit,
          offset: args.offset,
        })

    const fromSeqs = result.rows.map(row => row.seq)
    const relsMap = await batchFetchRelsWithTargets(this.pool, fromSeqs, args.ns)

    // Suppress unused variable warning for nsDoc
    void nsDoc

    const docs = result.rows.map((row) => {
      const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
      const rels = relsMap.get(row.seq) ?? []
      return {
        id: this.rowToSqid(row),
        ...(data as Record<string, unknown>),
        ...relsToDoc(rels, args.ns),
      } as { id: Sqid } & Record<string, unknown>
    })

    return { docs, total: result.total }
  }

  async findOne(args: {
    ns: string
    type: string
    where?: Where
    id?: string
  }): Promise<({ id: Sqid } & Record<string, unknown>) | null> {
    // Route actions-backed types to the actions table
    if (ACTIONS_COLLECTIONS.has(args.type) && args.id) {
      return this.findOneAction(args as { ns: string; type: string; id: string })
    }

    const parentNs = this.nsResolver.getParentNs(args.ns)
    let row: DataRow | null = null

    if (args.id) {
      const { seq } = fromSqid(args.id)
      // Try the current namespace first
      row = await findOneData(this.pool, { ns: args.ns, seq })
      // In a branch: if not found, check for forked doc or fall through to parent
      if (!row && parentNs) {
        // Check if doc is tombstoned in this branch
        const tombstone = await query<{ hidden: number }>(
          this.pool,
          `SELECT 1 AS hidden FROM data WHERE ns = $1 AND type = '_tombstone' AND (meta->>'_parent')::bigint = $2`,
          [args.ns, seq],
        )
        if (tombstone.rows.length > 0) {
          // Doc was deleted in this branch — return null
          row = null
        } else {
          // Look for a forked doc with _parent pointing to this seq (stored in meta)
          const forked = await query<DataRow>(
            this.pool,
            `SELECT * FROM data WHERE ns = $1 AND type NOT IN ('namespaces', '_tombstone') AND (meta->>'_parent')::bigint = $2 LIMIT 1`,
            [args.ns, seq],
          )
          if (forked.rows[0]) {
            row = forked.rows[0]
          } else {
            // Fall through to parent
            row = await findOneData(this.pool, { ns: parentNs, seq })
          }
        }
      }
    } else if (args.where) {
      // Use COW path for where queries in branches
      if (parentNs) {
        const result = await findDataCOW(this.pool, {
          ns: args.ns,
          parent: parentNs,
          type: args.type,
          where: args.where,
          limit: 1,
        })
        row = result.rows[0] ?? null
      } else {
        const result = await findData(this.pool, {
          ns: args.ns,
          type: args.type,
          where: args.where,
          limit: 1,
        })
        row = result.rows[0] ?? null
      }
    }

    if (!row) return null

    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
    const rels = await fetchRelsWithTargets(this.pool, row.seq, args.ns)
    return {
      id: this.rowToSqid(row),
      ...(data as Record<string, unknown>),
      ...relsToDoc(rels, args.ns),
    }
  }

  async updateOne(args: {
    ns: string
    type: string
    id: string
    data: Record<string, unknown>
    actor?: number
    meta?: RequestMeta
  }): Promise<{ id: Sqid; doc: unknown }> {
    const { seq: intSeq } = fromSqid(args.id)
    const parentNs = this.nsResolver.getParentNs(args.ns)
    const fields = this.getFields(args.type)

    return transaction(this.pool, async (tx) => {
      let workingSeq = intSeq

      // COW fork if in a branch
      if (parentNs) {
        let exists = await findOneData(tx, { ns: args.ns, seq: intSeq })
        if (!exists) {
          // Check if we already forked this doc (forked doc has _parent in meta)
          const forkedResult = await query<DataRow>(
            tx,
            `SELECT * FROM data WHERE ns = $1 AND type NOT IN ('namespaces', '_tombstone') AND (meta->>'_parent')::bigint = $2 LIMIT 1`,
            [args.ns, intSeq],
          )
          if (forkedResult.rows[0]) {
            exists = forkedResult.rows[0]
            workingSeq = exists.seq
          }
        }
        if (!exists) {
          const parentDoc = await findOneData(tx, { ns: parentNs, seq: intSeq })
          if (parentDoc) {
            const parentData = typeof parentDoc.data === 'string' ? JSON.parse(parentDoc.data) : parentDoc.data
            const forkedRow = await insertData(tx, {
              ns: args.ns,
              type: parentDoc.type,
              id: `${parentDoc.id}_fork_${args.ns}`,
              name: parentDoc.name,
              slug: parentDoc.slug,
              url: null, // Forked docs don't inherit parent URL (unique constraint)
              data: parentData,
              mdx: parentDoc.mdx,
              code: parentDoc.code,
              meta: { _parent: parentDoc.seq },
              status: parentDoc.status,
              locale: parentDoc.locale,
              rand: parentDoc.rand,
            })
            workingSeq = forkedRow.seq
          }
        }
      }

      // Merge existing doc with updates
      const current = await findOneData(tx, { ns: args.ns, seq: workingSeq })
      const currentData = current ? (typeof current.data === 'string' ? JSON.parse(current.data) : current.data) : {}
      const merged = { ...currentData, ...args.data }
      const { doc: mergedDoc, meta: mergedMeta } = splitMeta(merged)

      // Promote name from data
      const name = (mergedDoc.name as string) ?? (mergedDoc.title as string) ?? current?.name ?? null

      const row = await updateData(tx, {
        ns: args.ns,
        seq: workingSeq,
        data: mergedDoc,
        name,
        meta: Object.keys(mergedMeta).length > 0 ? mergedMeta : undefined,
        status: args.data.status as string | undefined,
        locale: args.data.locale as string | undefined,
      })

      // Rebuild relationships
      await deleteRelsForEntity(tx, { ns: args.ns, from: workingSeq })
      const rels = extractRels(mergedDoc as Record<string, unknown>, fields)
      for (const rel of rels) {
        await insertRel(tx, {
          ns: args.ns,
          from: workingSeq,
          to: rel.to,
          path: rel.path,
          sort: rel.sort,
        })
      }

      return { id: this.rowToSqid(row), doc: mergedDoc }
    })
  }

  async deleteMany(args: {
    ns: string
    type: string
    where: Where
    actor?: number
    meta?: RequestMeta
  }): Promise<{ deleted: number }> {
    const parentNs = this.nsResolver.getParentNs(args.ns)

    return transaction(this.pool, async (tx) => {
      // Use COW read path if in a branch, so we see parent docs too
      const result = parentNs
        ? await findDataCOW(tx, {
            ns: args.ns,
            parent: parentNs,
            type: args.type,
            where: args.where,
          })
        : await findData(tx, {
            ns: args.ns,
            type: args.type,
            where: args.where,
          })

      let deleted = 0
      for (const row of result.rows) {
        if (parentNs) {
          const rowMeta = row.meta as Record<string, unknown> | null
          const hasParent = rowMeta && '_parent' in rowMeta
          if (row.ns === args.ns && !hasParent) {
            // Branch-created doc (no _parent): delete the actual row
            await deleteData(tx, { ns: args.ns, seq: row.seq })
          } else {
            // Inherited from parent: write tombstone
            await insertData(tx, {
              ns: args.ns,
              type: '_tombstone',
              id: `_tomb_${row.seq}`,
              data: {},
              meta: { _parent: row.seq, _deleted: true },
              rand: 0,
            })
          }
        } else {
          await deleteData(tx, { ns: args.ns, seq: row.seq })
        }

        deleted++
      }

      return { deleted }
    })
  }

  // --- Relationships ---

  async relate(args: {
    ns: string
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
        from: fromDecoded.seq,
        to: toDecoded.seq,
        path: args.path,
        sort: args.sort,
      })
      return `rel_${rel.seq}` as Sqid
    })
  }

  async related(args: {
    ns?: string
    id: string
    path?: string
    direction?: 'from' | 'to'
  }): Promise<Array<{ id: Sqid; path: string }>> {
    const { seq } = fromSqid(args.id)
    const dir = args.direction ?? 'from'

    const rels = dir === 'from'
      ? await findRelsFrom(this.pool, { from: seq, path: args.path, ns: args.ns })
      : await findRelsTo(this.pool, { to: seq, ns: args.ns })

    const results: Array<{ id: Sqid; path: string }> = []
    for (const rel of rels) {
      const targetSeq = dir === 'from' ? rel.to : rel.from
      const target = await findOneData(this.pool, { ns: rel.ns, seq: targetSeq })
      if (target) {
        results.push({ id: this.rowToSqid(target), path: rel.path ?? '' })
      }
    }
    return results
  }

  // --- Durable Execution ---

  async enqueue(args: {
    ns: string
    type: string
    name: string
    input?: unknown
    entity?: string
    scheduled?: Date
  }): Promise<Sqid> {
    const entitySeq = args.entity ? fromSqid(args.entity).seq : undefined

    return transaction(this.pool, async (tx) => {
      const action = await enqueueAction(tx, {
        ns: args.ns,
        id: '', // placeholder
        type: args.type,
        name: args.name,
        input: args.input,
        entity: entitySeq,
        scheduled: args.scheduled,
      })

      const sqid = toSqid('actions', action.seq, args.ns, action.created, action.rand)
      await query(tx, `UPDATE actions SET id = $1 WHERE seq = $2`, [sqid, action.seq])
      return sqid as Sqid
    })
  }

  async dequeue(args: { ns: string; type?: string; limit?: number }): Promise<ActionRow[]> {
    return transaction(this.pool, async (tx) => {
      return dequeueActions(tx, args)
    })
  }

  async checkpoint(args: { id: string; step: number; result: unknown }): Promise<void> {
    const { seq } = fromSqid(args.id)
    return transaction(this.pool, async (tx) => {
      await checkpointAction(tx, { seq, step: args.step, result: args.result })
    })
  }

  async complete(args: { id: string; output?: unknown }): Promise<void> {
    const { seq } = fromSqid(args.id)
    await completeAction(this.pool, { seq, output: args.output })
  }

  async fail(args: { id: string; error: unknown }): Promise<void> {
    const { seq } = fromSqid(args.id)
    await failAction(this.pool, { seq, error: args.error })
  }

  // --- Events ---

  async emit(args: {
    ns: string
    kind: string
    entity?: number
    actor?: number
    meta?: unknown
  }): Promise<void> {
    await emit(this.pool, args)
  }

  // --- Search ---

  async search(args: {
    ns: string
    query: string
    type?: string
    limit?: number
  }): Promise<{ docs: Array<{ id: Sqid }>; scores: number[] }> {
    const conditions = ['ns = $1']
    const params: unknown[] = [args.ns]
    let paramIdx = 2

    if (args.type) {
      conditions.push(`type = $${paramIdx++}`)
      params.push(args.type)
    }

    conditions.push(`(name ILIKE $${paramIdx} OR data::text ILIKE $${paramIdx})`)
    params.push(`%${args.query}%`)
    paramIdx++

    const limit = args.limit ?? 10
    params.push(limit)

    const sql = `
      SELECT seq, type, ns, rand, created FROM data
      WHERE ${conditions.join(' AND ')}
      LIMIT $${paramIdx}
    `

    const result = await query<{ seq: number; type: string; ns: string; rand: number; created: Date }>(
      this.pool, sql, params,
    )

    const docs = result.rows.map(row => ({
      id: toSqid(row.type, row.seq, row.ns, row.created, row.rand) as Sqid,
    }))

    return { docs, scores: result.rows.map(() => 1) }
  }

  async findSimilar(args: {
    ns: string
    type?: string
    embedding: number[]
    limit?: number
  }): Promise<{ docs: Array<{ id: Sqid }>; scores: number[] }> {
    const conditions = ['ns = $1']
    const params: unknown[] = [args.ns]
    let paramIdx = 2

    if (args.type) {
      conditions.push(`type = $${paramIdx++}`)
      params.push(args.type)
    }

    params.push(`[${args.embedding.join(',')}]`)
    const embParam = `$${paramIdx++}`
    const limit = args.limit ?? 10
    params.push(limit)

    const sql = `
      SELECT seq, ns, type, rand, created, embedding <=> ${embParam}::vector AS score
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

  async resolveNs(req: { headers: { host?: string }; url?: string }): Promise<DataRow | null> {
    return this.nsResolver.resolveFromRequest(req)
  }

  async createBranch(args: {
    parentNs: string
    ns: string
    name?: string
    branch?: string
    kind?: string
    ttl?: string
    pr?: number
  }): Promise<DataRow> {
    const ns = await createBranch(this.pool, args)
    await this.nsResolver.refresh()
    return ns
  }

  async mergeBranch(branchNs: string): Promise<{ merged: number; deleted: number }> {
    const result = await mergeBranch(this.pool, branchNs)
    await this.nsResolver.refresh()
    return result
  }
}

// --- Helpers ---

interface RelWithTarget extends RelRow {
  targetType: string
  targetCreated: Date
  targetRand: number
  targetNs: string
}

async function fetchRelsWithTargets(
  pool: PgPool,
  fromSeq: number,
  ns?: string,
): Promise<RelWithTarget[]> {
  if (ns !== undefined) {
    const result = await query<RelWithTarget>(
      pool,
      `SELECT r.*, d.type AS "targetType", d.created AS "targetCreated",
              d.rand AS "targetRand", d.ns AS "targetNs"
       FROM rels r
       JOIN data d ON d.seq = r."to"
       WHERE r."from" = $1 AND r.ns = $2
       ORDER BY r.path, r.sort`,
      [fromSeq, ns],
    )
    return result.rows
  }
  const result = await query<RelWithTarget>(
    pool,
    `SELECT r.*, d.type AS "targetType", d.created AS "targetCreated",
            d.rand AS "targetRand", d.ns AS "targetNs"
     FROM rels r
     JOIN data d ON d.seq = r."to"
     WHERE r."from" = $1
     ORDER BY r.path, r.sort`,
    [fromSeq],
  )
  return result.rows
}

async function batchFetchRelsWithTargets(
  pool: PgPool,
  fromSeqs: number[],
  ns?: string,
): Promise<Map<number, RelWithTarget[]>> {
  const map = new Map<number, RelWithTarget[]>()
  if (fromSeqs.length === 0) return map

  const result = ns !== undefined
    ? await query<RelWithTarget>(
        pool,
        `SELECT r.*, d.type AS "targetType", d.created AS "targetCreated",
                d.rand AS "targetRand", d.ns AS "targetNs"
         FROM rels r
         JOIN data d ON d.seq = r."to"
         WHERE r."from" = ANY($1) AND r.ns = $2
         ORDER BY r."from", r.path, r.sort`,
        [fromSeqs, ns],
      )
    : await query<RelWithTarget>(
        pool,
        `SELECT r.*, d.type AS "targetType", d.created AS "targetCreated",
                d.rand AS "targetRand", d.ns AS "targetNs"
         FROM rels r
         JOIN data d ON d.seq = r."to"
         WHERE r."from" = ANY($1)
         ORDER BY r."from", r.path, r.sort`,
        [fromSeqs],
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
  _ns: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const grouped = new Map<string, RelWithTarget[]>()

  for (const rel of rels) {
    const path = rel.path ?? ''
    const basePath = path.replace(/\.\d+$/, '')
    if (!grouped.has(basePath)) grouped.set(basePath, [])
    grouped.get(basePath)!.push(rel)
  }

  for (const [path, pathRels] of grouped) {
    if (pathRels.length === 1 && pathRels[0].path && !pathRels[0].path.match(/\.\d+$/)) {
      const r = pathRels[0]
      result[path] = toSqid(r.targetType, r.to, r.targetNs, r.targetCreated, r.targetRand)
    } else {
      result[path] = pathRels
        .sort((a, b) => a.sort - b.sort)
        .map(r => toSqid(r.targetType, r.to, r.targetNs, r.targetCreated, r.targetRand))
    }
  }

  return result
}

/**
 * Build a URL from ns, type, and slug/id.
 */
function buildUrl(ns: string, type: string, slugOrId?: string): string | null {
  if (!slugOrId) return null
  if (type === 'namespaces') return ns
  return `${ns}/${type}/${slugOrId}`
}

/** Fields that belong in the `meta` JSONB column rather than `data` JSONB */
const META_FIELDS = new Set(['_parent', '_globalSlug', '_deleted'])

/**
 * Split adapter-internal fields into `meta` and user content into `data`.
 * `meta` is stored as JSONB (queryable for internal lookups),
 * `data` is stored as JSONB (the full Payload document).
 */
function splitMeta(data: Record<string, unknown>): { doc: Record<string, unknown>; meta: Record<string, unknown> } {
  const doc: Record<string, unknown> = {}
  const meta: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (META_FIELDS.has(key)) {
      meta[key] = value
    } else {
      doc[key] = value
    }
  }
  return { doc, meta }
}
