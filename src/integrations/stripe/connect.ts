import type { PgPool } from '../../db/pg.js'
import { query } from '../../db/pg.js'
import type { StripeConfig } from './billing.js'

export async function createConnectAccount(
  pool: PgPool,
  config: StripeConfig,
  nsId: number,
  type: 'standard' | 'express' = 'standard',
): Promise<string> {
  const nsResult = await query<{ uri: string; name: string | null }>(
    pool, `SELECT uri, name FROM ns WHERE id = $1`, [nsId],
  )
  const ns = nsResult.rows[0]

  const response = await fetch('https://api.stripe.com/v1/accounts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      type,
      'metadata[nsId]': String(nsId),
      'business_profile[name]': ns?.name ?? '',
      'business_profile[url]': `https://${ns?.uri ?? ''}`,
    }),
  })

  if (!response.ok) {
    throw new Error(`Stripe createConnectAccount failed: ${response.status} ${await response.text()}`)
  }
  const account = await response.json() as { id: string }
  await query(pool, `UPDATE ns SET connect = $1, updated = now() WHERE id = $2`, [account.id, nsId])
  return account.id
}

export async function getOnboardingLink(
  config: StripeConfig,
  accountId: string,
  returnUrl: string,
  refreshUrl: string,
): Promise<string> {
  const response = await fetch('https://api.stripe.com/v1/account_links', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      account: accountId,
      return_url: returnUrl,
      refresh_url: refreshUrl,
      type: 'account_onboarding',
    }),
  })

  if (!response.ok) {
    throw new Error(`Stripe getOnboardingLink failed: ${response.status} ${await response.text()}`)
  }
  const link = await response.json() as { url: string }
  return link.url
}

export async function createPaymentIntent(
  config: StripeConfig,
  connectAccountId: string,
  amount: number,
  currency: string = 'usd',
  applicationFee?: number,
): Promise<{ id: string; clientSecret: string }> {
  const params = new URLSearchParams({
    amount: String(amount),
    currency,
  })
  if (applicationFee) {
    params.set('application_fee_amount', String(applicationFee))
  }

  const response = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.secretKey}`,
      'Stripe-Account': connectAccountId,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  })

  if (!response.ok) {
    throw new Error(`Stripe createPaymentIntent failed: ${response.status} ${await response.text()}`)
  }
  return response.json() as Promise<{ id: string; clientSecret: string }>
}

export async function getBalance(
  config: StripeConfig,
  connectAccountId: string,
): Promise<{ available: number; pending: number }> {
  const response = await fetch('https://api.stripe.com/v1/balance', {
    headers: {
      'Authorization': `Bearer ${config.secretKey}`,
      'Stripe-Account': connectAccountId,
    },
  })

  if (!response.ok) {
    throw new Error(`Stripe getBalance failed: ${response.status} ${await response.text()}`)
  }
  const balance = await response.json() as {
    available: Array<{ amount: number }>
    pending: Array<{ amount: number }>
  }

  return {
    available: balance.available.reduce((sum, b) => sum + b.amount, 0),
    pending: balance.pending.reduce((sum, b) => sum + b.amount, 0),
  }
}
