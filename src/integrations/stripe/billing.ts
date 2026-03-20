import type { PgPool } from '../../db/pg.js'
import { query } from '../../db/pg.js'

export interface StripeConfig {
  secretKey: string
}

export async function createCustomer(
  pool: PgPool,
  config: StripeConfig,
  nsId: number,
  email: string,
): Promise<string> {
  const response = await fetch('https://api.stripe.com/v1/customers', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      email,
      'metadata[nsId]': String(nsId),
    }),
  })

  if (!response.ok) {
    throw new Error(`Stripe createCustomer failed: ${response.status} ${await response.text()}`)
  }
  const customer = await response.json() as { id: string }
  await query(pool, `UPDATE ns SET stripe = $1, updated = now() WHERE id = $2`, [customer.id, nsId])
  return customer.id
}

export async function createSubscription(
  pool: PgPool,
  config: StripeConfig,
  nsId: number,
  customerId: string,
  priceId: string,
): Promise<string> {
  const response = await fetch('https://api.stripe.com/v1/subscriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      customer: customerId,
      'items[0][price]': priceId,
      'metadata[nsId]': String(nsId),
    }),
  })

  if (!response.ok) {
    throw new Error(`Stripe createSubscription failed: ${response.status} ${await response.text()}`)
  }
  const subscription = await response.json() as { id: string }
  const plan = derivePlan(priceId)
  await query(
    pool,
    `UPDATE ns SET subscription = $1, plan = $2, updated = now() WHERE id = $3`,
    [subscription.id, plan, nsId],
  )
  return subscription.id
}

export async function cancelSubscription(
  pool: PgPool,
  config: StripeConfig,
  nsId: number,
  subscriptionId: string,
): Promise<void> {
  const response = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${config.secretKey}` },
  })
  if (!response.ok) {
    throw new Error(`Stripe cancelSubscription failed: ${response.status} ${await response.text()}`)
  }

  await query(
    pool,
    `UPDATE ns SET subscription = NULL, plan = 'free', updated = now() WHERE id = $1`,
    [nsId],
  )
}

export async function getPlan(pool: PgPool, nsId: number): Promise<string> {
  const result = await query<{ plan: string }>(pool, `SELECT plan FROM ns WHERE id = $1`, [nsId])
  return result.rows[0]?.plan ?? 'free'
}

function derivePlan(priceId: string): string {
  // Map Stripe price IDs to plan names
  if (priceId.includes('enterprise')) return 'enterprise'
  if (priceId.includes('pro')) return 'pro'
  return 'free'
}
