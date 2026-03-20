import type pg from 'pg'
import { query } from '../db/pg.js'

export interface BudgetCheckResult {
  totalSpent: number
  percentUsed: number
  exceeded: boolean
  warning: boolean
}

export async function checkBudget(
  pool: pg.Pool,
  nsId: number,
  limit: number,
  warningThreshold: number = 80,
): Promise<BudgetCheckResult> {
  const result = await query<{ total: string }>(
    pool,
    `SELECT COALESCE(SUM((doc->>'amount')::numeric), 0) AS total
     FROM data
     WHERE ns = $1 AND collection = 'cost-events'`,
    [nsId],
  )

  const totalSpent = parseFloat(result.rows[0].total)

  // limit <= 0 means unlimited (no budget constraint)
  if (limit <= 0) {
    return {
      totalSpent,
      percentUsed: 0,
      exceeded: false,
      warning: false,
    }
  }

  const percentUsed = (totalSpent / limit) * 100

  return {
    totalSpent,
    percentUsed,
    exceeded: totalSpent >= limit,
    warning: percentUsed >= warningThreshold,
  }
}
