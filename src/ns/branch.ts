import type pg from 'pg'
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
  pool: pg.Pool,
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
  pool: pg.Pool,
  branchNsId: number,
): Promise<{ merged: number; deleted: number }> {
  return transaction(pool, async (tx) => {
    // Get branch ns
    const nsResult = await query<NsRow>(tx, `SELECT * FROM ns WHERE id = $1`, [branchNsId])
    const branch = nsResult.rows[0]
    if (!branch) throw new Error(`Branch namespace not found: ${branchNsId}`)
    if (!branch.parent) throw new Error(`Cannot merge a root namespace`)

    // Get modified docs (excluding tombstones)
    const docsResult = await query<{ id: number; doc: unknown; collection: string; slug: string | null; status: string | null; locale: string | null; rand: number; created: Date }>(
      tx,
      `SELECT id, doc, collection, slug, status, locale, rand, created FROM data WHERE ns = $1 AND collection != '_tombstone'`,
      [branchNsId],
    )

    let merged = 0
    for (const doc of docsResult.rows) {
      const parsed = typeof doc.doc === 'string' ? JSON.parse(doc.doc) : { ...doc.doc as Record<string, unknown> }
      const parentId = parsed._parent
      delete parsed._parent

      if (parentId) {
        // Update existing parent document
        await query(
          tx,
          `UPDATE data SET doc = $1, updated = now() WHERE ns = $2 AND id = $3`,
          [JSON.stringify(parsed), branch.parent, parentId],
        )
      } else {
        // New document created in branch — insert into parent
        await query(
          tx,
          `INSERT INTO data (ns, collection, slug, doc, status, locale, rand, created, updated)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
          [branch.parent, doc.collection, doc.slug, JSON.stringify(parsed), doc.status, doc.locale, doc.rand, doc.created],
        )
      }
      merged++
    }

    // Handle tombstones — delete from parent
    const tombResult = await query<{ doc: unknown }>(
      tx,
      `SELECT doc FROM data WHERE ns = $1 AND collection = '_tombstone'`,
      [branchNsId],
    )
    let deleted = 0
    for (const t of tombResult.rows) {
      const tombDoc = typeof t.doc === 'string' ? JSON.parse(t.doc) : t.doc as Record<string, unknown>
      const { _parent } = tombDoc
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
  pool: pg.Pool,
  branchNsId: number,
): Promise<void> {
  await transaction(pool, async (tx) => {
    await query(tx, `DELETE FROM rels WHERE ns = $1`, [branchNsId])
    await query(tx, `DELETE FROM pending WHERE ns = $1`, [branchNsId])
    await query(tx, `DELETE FROM data WHERE ns = $1`, [branchNsId])
    await query(tx, `DELETE FROM ns WHERE id = $1`, [branchNsId])
  })
}

export async function cleanupExpiredPreviews(pool: pg.Pool): Promise<number> {
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
