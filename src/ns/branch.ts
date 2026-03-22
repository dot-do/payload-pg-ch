import type { PgPool } from '../db/pg.js'
import type { DataRow } from '../types.js'
import { query, transaction } from '../db/pg.js'
import { generateRand } from '../id/sqids.js'

export interface CreateBranchArgs {
  parentNs: string
  ns: string
  name?: string
  branch?: string
  kind?: string
  ttl?: string
  pr?: number
}

/**
 * Create a branch namespace by inserting a `type='namespaces'` doc in the data table.
 * Parent info is stored in the `meta` JSONB column.
 */
export async function createBranch(
  pool: PgPool,
  args: CreateBranchArgs,
): Promise<DataRow> {
  const rand = generateRand()
  const meta: Record<string, unknown> = {
    _parent: args.parentNs,
    kind: args.kind ?? 'preview',
  }
  if (args.branch) meta.branch = args.branch
  if (args.ttl) meta.ttl = args.ttl
  if (args.pr) meta.pr = args.pr

  const result = await query<DataRow>(
    pool,
    `INSERT INTO data (id, ns, type, name, data, meta, rand)
     VALUES ($1, $2, 'namespaces', $3, '{}', $4, $5)
     RETURNING *`,
    [
      args.ns,
      args.ns,
      args.name ?? args.ns,
      JSON.stringify(meta),
      rand,
    ],
  )
  return result.rows[0]
}

/**
 * Merge a branch namespace into its parent.
 * Reads all docs from the branch (excluding tombstones), applies them to the parent ns.
 */
export async function mergeBranch(
  pool: PgPool,
  branchNs: string,
): Promise<{ merged: number; deleted: number }> {
  return transaction(pool, async (tx) => {
    // Get the branch namespace doc
    const nsResult = await query<DataRow>(
      tx,
      `SELECT * FROM data WHERE type = 'namespaces' AND ns = $1 LIMIT 1`,
      [branchNs],
    )
    const branchDoc = nsResult.rows[0]
    if (!branchDoc) throw new Error(`Branch namespace not found: ${branchNs}`)
    const branchMeta = branchDoc.meta as Record<string, unknown> | null
    const parentNs = branchMeta?._parent as string | undefined
    if (!parentNs) throw new Error(`Cannot merge a root namespace`)
    if (branchMeta?.merged) throw new Error('Branch already merged')

    // Get modified docs (excluding tombstones and the namespace doc itself)
    const docsResult = await query<DataRow>(
      tx,
      `SELECT * FROM data WHERE ns = $1 AND type != '_tombstone' AND type != 'namespaces'`,
      [branchNs],
    )

    let merged = 0
    for (const row of docsResult.rows) {
      const rowData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
      const rowMeta = (typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta) as Record<string, unknown> | null
      const parentSeq = rowMeta?._parent as number | undefined

      if (parentSeq) {
        // Update existing parent document (all promoted columns + data)
        await query(
          tx,
          `UPDATE data SET data = $1, name = $4, slug = $5, mdx = $6, code = $7,
           status = $8, locale = $9, meta = $10, embedding = $11,
           version = version + 1, updated = now()
           WHERE ns = $2 AND seq = $3`,
          [
            JSON.stringify(rowData), parentNs, parentSeq,
            row.name, row.slug, row.mdx, row.code,
            row.status, row.locale,
            row.meta ? JSON.stringify(typeof row.meta === 'object' ? row.meta : {}) : '{}',
            row.embedding,
          ],
        )
        // Copy rels from branch to parent (replace old parent rels)
        await query(tx, `DELETE FROM rels WHERE ns = $1 AND "from" = $2`, [parentNs, parentSeq])
        const branchRels = await query<{ to: number; path: string; sort: number; meta: unknown }>(
          tx,
          `SELECT "to", path, sort, meta FROM rels WHERE ns = $1 AND "from" = $2`,
          [branchNs, row.seq],
        )
        for (const rel of branchRels.rows) {
          await query(
            tx,
            `INSERT INTO rels (ns, "from", "to", path, sort, meta) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT ("from", path, "to") DO UPDATE SET sort = $5, meta = $6`,
            [parentNs, parentSeq, rel.to, rel.path, rel.sort, rel.meta ? JSON.stringify(rel.meta) : null],
          )
        }
      } else {
        // New document created in branch — insert into parent
        const newRow = await query<{ seq: number }>(
          tx,
          `INSERT INTO data (id, ns, type, name, slug, url, data, mdx, code, meta, status, locale, rand, created, updated)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
           ON CONFLICT (url) DO UPDATE SET url = NULL
           RETURNING seq`,
          [
            row.id, parentNs, row.type, row.name, row.slug, null,
            JSON.stringify(rowData), row.mdx, row.code,
            '{}', row.status, row.locale, row.rand, row.created,
          ],
        )
        // Copy rels from branch to parent for new doc
        const branchRels = await query<{ to: number; path: string; sort: number; meta: unknown }>(
          tx,
          `SELECT "to", path, sort, meta FROM rels WHERE ns = $1 AND "from" = $2`,
          [branchNs, row.seq],
        )
        for (const rel of branchRels.rows) {
          await query(
            tx,
            `INSERT INTO rels (ns, "from", "to", path, sort, meta) VALUES ($1, $2, $3, $4, $5, $6)`,
            [parentNs, newRow.rows[0].seq, rel.to, rel.path, rel.sort, rel.meta ? JSON.stringify(rel.meta) : null],
          )
        }
      }
      merged++
    }

    // Handle tombstones — delete from parent
    const tombResult = await query<{ meta: unknown }>(
      tx,
      `SELECT meta FROM data WHERE ns = $1 AND type = '_tombstone'`,
      [branchNs],
    )
    let deleted = 0
    for (const t of tombResult.rows) {
      const tombMeta = (typeof t.meta === 'string' ? JSON.parse(t.meta) : t.meta) as Record<string, unknown> | null
      const parentSeq = tombMeta?._parent as number | undefined
      if (parentSeq) {
        await query(tx, `DELETE FROM data WHERE ns = $1 AND seq = $2`, [parentNs, parentSeq])
        deleted++
      }
    }

    // Mark branch as merged
    await query(
      tx,
      `UPDATE data SET meta = meta::jsonb || '{"merged": true}'::jsonb, updated = now()
       WHERE type = 'namespaces' AND ns = $1`,
      [branchNs],
    )

    return { merged, deleted }
  })
}

/**
 * Clean up all data for a branch namespace.
 */
export async function cleanupBranch(
  pool: PgPool,
  branchNs: string,
): Promise<void> {
  await transaction(pool, async (tx) => {
    await query(tx, `DELETE FROM events WHERE ns = $1`, [branchNs])
    await query(tx, `DELETE FROM rels WHERE ns = $1`, [branchNs])
    await query(tx, `DELETE FROM data WHERE ns = $1`, [branchNs])
  })
}

export async function cleanupExpiredPreviews(pool: PgPool): Promise<number> {
  const expired = await query<{ ns: string; meta: unknown }>(
    pool,
    `SELECT ns, meta FROM data
     WHERE type = 'namespaces'
       AND meta->>'kind' = 'preview'
       AND meta->>'merged' IS NULL
       AND meta->>'ttl' IS NOT NULL
       AND created + (meta->>'ttl')::interval < now()`,
  )
  for (const row of expired.rows) {
    await cleanupBranch(pool, row.ns)
  }
  return expired.rows.length
}
