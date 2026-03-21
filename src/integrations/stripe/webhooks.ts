import type { PgPool } from '../../db/pg.js'
import { query } from '../../db/pg.js'
import { emit } from '../../db/queries/events.js'

export interface StripeWebhookConfig {
  webhookSecret: string
  connectWebhookSecret?: string
}

interface StripeEvent {
  id: string
  type: string
  data: {
    object: Record<string, unknown> & {
      metadata?: Record<string, string>
    }
  }
}

export async function handleStripeWebhook(
  pool: PgPool,
  event: StripeEvent,
): Promise<void> {
  const nsId = event.data.object.metadata?.nsId
    ? parseInt(event.data.object.metadata.nsId, 10)
    : null

  if (!nsId) return

  // Log all Stripe events (flows through CDC to ClickHouse)
  await emit(pool, {
    ns: nsId,
    kind: `stripe.${event.type}`,
    meta: event.data.object,
  })

  // Handle specific event types
  switch (event.type) {
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Record<string, unknown>
      const status = subscription.status as string
      const plan = status === 'active' ? derivePlanFromSubscription(subscription) : 'free'
      await query(pool, `UPDATE ns SET plan = $1, updated = now() WHERE id = $2`, [plan, nsId])
      break
    }

    case 'account.updated': {
      const account = event.data.object as Record<string, unknown>
      const chargesEnabled = account.charges_enabled as boolean
      await query(
        pool,
        `UPDATE ns SET onboarded = $1, updated = now() WHERE id = $2`,
        [chargesEnabled, nsId],
      )
      break
    }
  }
}

function derivePlanFromSubscription(subscription: Record<string, unknown>): string {
  const items = subscription.items as { data: Array<{ price: { id: string } }> } | undefined
  const priceId = items?.data[0]?.price?.id ?? ''
  if (priceId.includes('enterprise')) return 'enterprise'
  if (priceId.includes('pro')) return 'pro'
  return 'free'
}
