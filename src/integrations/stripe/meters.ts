import type { PgPool } from '../../db/pg.js'
import { query } from '../../db/pg.js'

export interface MeterConfig {
  secretKey: string
  meterMapping?: Record<string, string> // event kind → Stripe meter event name
}

export async function reportUsage(
  pool: PgPool,
  config: MeterConfig,
  nsId: number,
  since: Date,
): Promise<void> {
  // Get Stripe customer ID
  const nsResult = await query<{ stripe: string | null }>(
    pool, `SELECT stripe FROM ns WHERE id = $1`, [nsId],
  )
  const customerId = nsResult.rows[0]?.stripe
  if (!customerId) return

  // Count events by kind
  const counts = await query<{ kind: string; total: string }>(
    pool,
    `SELECT kind, count(*) AS total FROM events
     WHERE ns = $1 AND created >= $2
     GROUP BY kind`,
    [nsId, since],
  )

  const mapping = config.meterMapping ?? defaultMeterMapping

  for (const { kind, total } of counts.rows) {
    const meterName = mapping[kind]
    if (!meterName) continue

    const meterResponse = await fetch('https://api.stripe.com/v1/billing/meter_events', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        event_name: meterName,
        'payload[value]': total,
        'payload[stripe_customer_id]': customerId,
      }),
    })
    if (!meterResponse.ok) {
      throw new Error(`Stripe reportUsage failed for ${meterName}: ${meterResponse.status} ${await meterResponse.text()}`)
    }
  }
}

const defaultMeterMapping: Record<string, string> = {
  'data.created': 'document_writes',
  'data.updated': 'document_writes',
  'ai.generated': 'ai_generations',
  'search.query': 'search_queries',
}
