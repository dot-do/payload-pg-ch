import type { PgPool } from '../db/pg.js'
import { query } from '../db/pg.js'

export interface RetentionConfig {
  logRetentionDays?: number
  pendingRetentionDays?: number
  searchRetentionDays?: number
}

export async function runRetention(
  pool: PgPool,
  config: RetentionConfig = {},
): Promise<{ prunedPending: number; prunedSearch: number }> {
  const pendingDays = config.pendingRetentionDays ?? 7
  const searchDays = config.searchRetentionDays ?? 7

  // Prune completed pending rows
  const pendingResult = await query(
    pool,
    `DELETE FROM pending
     WHERE status = 'done' AND created < now() - $1::interval
     RETURNING id`,
    [`${pendingDays} days`],
  )

  // Prune old search transit rows (authoritative copy in ClickHouse)
  const searchResult = await query(
    pool,
    `DELETE FROM search
     WHERE created < now() - $1::interval
     RETURNING id`,
    [`${searchDays} days`],
  )

  return {
    prunedPending: pendingResult.rowCount ?? 0,
    prunedSearch: searchResult.rowCount ?? 0,
  }
}

export async function dropOldLogPartitions(
  pool: PgPool,
  retentionDays: number = 90,
): Promise<string[]> {
  // List log partitions
  const result = await query<{ tablename: string }>(
    pool,
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename LIKE 'log_%'
     ORDER BY tablename`,
  )

  const dropped: string[] = []
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - retentionDays)
  const cutoffMonth = `${cutoff.getFullYear()}${String(cutoff.getMonth() + 1).padStart(2, '0')}`

  for (const { tablename } of result.rows) {
    // Extract YYYYMM from partition name like log_202401
    const match = tablename.match(/^log_(\d{6})$/)
    if (match && match[1] < cutoffMonth) {
      await query(pool, `DROP TABLE IF EXISTS ${tablename}`)
      dropped.push(tablename)
    }
  }

  return dropped
}
