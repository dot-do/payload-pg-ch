import type { PgPool } from '../db/pg.js'
import { cleanupExpiredPreviews } from '../ns/branch.js'
import { emit } from '../db/queries/log.js'

export async function runPreviewCleanup(pool: PgPool): Promise<number> {
  const cleaned = await cleanupExpiredPreviews(pool)
  if (cleaned > 0) {
    await emit(pool, {
      ns: 0, // system-level event
      kind: 'preview.cleanup',
      meta: { cleaned },
    })
  }
  return cleaned
}
