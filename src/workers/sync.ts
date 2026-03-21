import type { PgPool } from '../db/pg.js'
import type { DataRow } from '../types.js'
import { query } from '../db/pg.js'

export interface SyncConfig {
  githubToken: string
}

export async function syncPull(
  _pool: PgPool,
  ns: DataRow,
  _config: SyncConfig,
): Promise<{ commit: string; changed: number }> {
  const meta = ns.meta as Record<string, unknown> | null
  if (!meta?.repo) {
    throw new Error(`Namespace ${ns.ns} has no repo configured`)
  }

  // TODO: Implement GitHub API integration
  // 1. Fetch commits since meta.commit using GitHub API
  // 2. For each changed file under meta.root: parse -> upsert data
  // 3. Update namespace doc with commit, synced
  // 4. Create version entries with commit SHA

  const commit = (meta.commit as string) ?? 'HEAD'
  await query(
    _pool,
    `UPDATE data SET meta = meta::jsonb || '{"synced": true}'::jsonb, updated = now()
     WHERE type = 'namespaces' AND ns = $1`,
    [ns.ns],
  )

  return { commit, changed: 0 }
}

export async function syncPush(
  _pool: PgPool,
  ns: DataRow,
  _config: SyncConfig,
): Promise<{ commit: string; changed: number }> {
  const meta = ns.meta as Record<string, unknown> | null
  if (!meta?.repo) {
    throw new Error(`Namespace ${ns.ns} has no repo configured`)
  }

  // TODO: Implement GitHub API integration
  // 1. Serialize doc JSON back to file format
  // 2. Use GitHub Contents API to commit + push
  // 3. Store resulting commit SHA
  // 4. Skip webhook processing for bot-authored commits

  return { commit: '', changed: 0 }
}
