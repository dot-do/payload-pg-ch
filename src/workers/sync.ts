import type pg from 'pg'
import type { NsRow } from '../types.js'
import { query } from '../db/pg.js'

export interface SyncConfig {
  githubToken: string
}

export async function syncPull(
  _pool: pg.Pool,
  ns: NsRow,
  _config: SyncConfig,
): Promise<{ commit: string; changed: number }> {
  if (!ns.repo) {
    throw new Error(`Namespace ${ns.id} has no repo configured`)
  }

  // TODO: Implement GitHub API integration
  // 1. Fetch commits since ns.commit using GitHub API
  // 2. For each changed file under ns.root: parse → upsert data
  // 3. Update ns.commit, ns.synced
  // 4. Create version entries with commit SHA

  const commit = ns.commit ?? 'HEAD'
  await query(_pool, `UPDATE ns SET synced = now() WHERE id = $1`, [ns.id])

  return { commit, changed: 0 }
}

export async function syncPush(
  _pool: pg.Pool,
  ns: NsRow,
  _config: SyncConfig,
): Promise<{ commit: string; changed: number }> {
  if (!ns.repo) {
    throw new Error(`Namespace ${ns.id} has no repo configured`)
  }

  // TODO: Implement GitHub API integration
  // 1. Serialize doc JSON back to file format
  // 2. Use GitHub Contents API to commit + push
  // 3. Store resulting commit SHA
  // 4. Skip webhook processing for bot-authored commits

  return { commit: '', changed: 0 }
}
