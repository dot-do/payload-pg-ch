import type { PgPool } from '../db/pg.js'
import type { NsRow } from '../types.js'
import { query, transaction } from '../db/pg.js'

export interface CreateBranchArgs {
  parent: number
  uri: string
  name?: string
  branch?: string
  kind?: string
  ttl?: string
  pr?: number
  repo?: string
  root?: string
  githuborgid?: number | null
}

export async function createBranch(
  pool: PgPool,
  args: CreateBranchArgs,
): Promise<NsRow> {
  const result = await query<NsRow>(
    pool,
    `INSERT INTO ns (uri, name, parent, kind, branch, ttl, pr, repo, root, githuborgid)
     VALUES ($1, $2, $3, $4, $5, $6::interval, $7, $8, $9, $10)
     RETURNING *`,
    [
      args.uri,
      args.name ?? null,
      args.parent,
      args.kind ?? 'preview',
      args.branch ?? null,
      args.ttl ?? null,
      args.pr ?? null,
      args.repo ?? null,
      args.root ?? '/',
      args.githuborgid ?? null,
    ],
  )
  return result.rows[0]
}

export async function mergeBranch(
  pool: PgPool,
  branchNsId: number,
): Promise<{ merged: number; deleted: number }> {
  return transaction(pool, async (tx) => {
    // Get branch ns
    const nsResult = await query<NsRow>(tx, `SELECT * FROM ns WHERE id = $1`, [branchNsId])
    const branch = nsResult.rows[0]
    if (!branch) throw new Error(`Branch namespace not found: ${branchNsId}`)
    if (!branch.parent) throw new Error(`Cannot merge a root namespace`)
    if (branch.merged) throw new Error('Branch already merged')

    // Get modified docs (excluding tombstones)
    const docsResult = await query<{ id: number; doc: unknown; meta: unknown; collection: string; slug: string | null; status: string | null; locale: string | null; rand: number; created: Date }>(
      tx,
      `SELECT id, doc, meta, collection, slug, status, locale, rand, created FROM data WHERE ns = $1 AND collection != '_tombstone'`,
      [branchNsId],
    )

    let merged = 0
    for (const row of docsResult.rows) {
      const parsed = typeof row.doc === 'string' ? JSON.parse(row.doc) : { ...row.doc as Record<string, unknown> }
      const rowMeta = (typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta) as Record<string, unknown> | null
      const parentId = rowMeta?._parent as number | undefined

      if (parentId) {
        // Update existing parent document
        await query(
          tx,
          `UPDATE data SET doc = $1, version = version + 1, updated = now() WHERE ns = $2 AND id = $3`,
          [JSON.stringify(parsed), branch.parent, parentId],
        )
        // Copy rels from branch to parent (replace old parent rels)
        await query(tx, `DELETE FROM rels WHERE ns = $1 AND "from" = $2`, [branch.parent, parentId])
        const branchRels = await query<{ to: number; path: string; sort: number; meta: unknown }>(
          tx,
          `SELECT "to", path, sort, meta FROM rels WHERE ns = $1 AND "from" = $2`,
          [branchNsId, row.id],
        )
        for (const rel of branchRels.rows) {
          await query(
            tx,
            `INSERT INTO rels (ns, "from", "to", path, sort, meta) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT ("from", path, "to") DO UPDATE SET sort = $5, meta = $6`,
            [branch.parent, parentId, rel.to, rel.path, rel.sort, rel.meta ? JSON.stringify(rel.meta) : null],
          )
        }
      } else {
        // New document created in branch — insert into parent
        const newRow = await query<{ id: number }>(
          tx,
          `INSERT INTO data (ns, collection, slug, doc, status, locale, rand, created, updated)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
           RETURNING id`,
          [branch.parent, row.collection, row.slug, JSON.stringify(parsed), row.status, row.locale, row.rand, row.created],
        )
        // Copy rels from branch to parent for new doc
        const branchRels = await query<{ to: number; path: string; sort: number; meta: unknown }>(
          tx,
          `SELECT "to", path, sort, meta FROM rels WHERE ns = $1 AND "from" = $2`,
          [branchNsId, row.id],
        )
        for (const rel of branchRels.rows) {
          await query(
            tx,
            `INSERT INTO rels (ns, "from", "to", path, sort, meta) VALUES ($1, $2, $3, $4, $5, $6)`,
            [branch.parent, newRow.rows[0].id, rel.to, rel.path, rel.sort, rel.meta ? JSON.stringify(rel.meta) : null],
          )
        }
      }
      merged++
    }

    // Handle tombstones — delete from parent
    const tombResult = await query<{ meta: unknown }>(
      tx,
      `SELECT meta FROM data WHERE ns = $1 AND collection = '_tombstone'`,
      [branchNsId],
    )
    let deleted = 0
    for (const t of tombResult.rows) {
      const tombMeta = (typeof t.meta === 'string' ? JSON.parse(t.meta) : t.meta) as Record<string, unknown> | null
      const _parent = tombMeta?._parent
      if (_parent) {
        await query(tx, `DELETE FROM data WHERE ns = $1 AND id = $2`, [branch.parent, _parent])
        deleted++
      }
    }

    // Mark branch as merged
    await query(tx, `UPDATE ns SET merged = now() WHERE id = $1`, [branchNsId])

    return { merged, deleted }
  })
}

export async function cleanupBranch(
  pool: PgPool,
  branchNsId: number,
): Promise<void> {
  await transaction(pool, async (tx) => {
    await query(tx, `DELETE FROM rels WHERE ns = $1`, [branchNsId])
    await query(tx, `DELETE FROM data WHERE ns = $1`, [branchNsId])
    await query(tx, `DELETE FROM ns WHERE id = $1`, [branchNsId])
  })
}

export async function cleanupExpiredPreviews(pool: PgPool): Promise<number> {
  const expired = await query<{ id: number }>(
    pool,
    `SELECT id FROM ns
     WHERE kind = 'preview' AND merged IS NULL AND ttl IS NOT NULL
       AND created + ttl < now()`,
  )
  for (const ns of expired.rows) {
    await cleanupBranch(pool, ns.id)
  }
  return expired.rows.length
}
