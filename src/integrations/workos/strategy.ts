import type pg from 'pg'
import { query } from '../../db/pg.js'

export interface WorkOSConfig {
  apiKey: string
  clientId: string
}

export interface WorkOSSession {
  user: {
    id: string
    email: string
    firstName: string
    lastName: string
    externalId?: string // GitHub numeric ID if OAuth provider is GitHub
  }
  organizationId?: string
}

export function createAuthStrategy(pool: pg.Pool, config: WorkOSConfig) {
  return {
    name: 'workos' as const,
    authenticate: async ({ headers }: { headers: Headers }) => {
      const token = headers.get('authorization')?.replace('Bearer ', '')
      if (!token) return { user: null }

      try {
        // Verify with WorkOS
        const session = await verifySession(config.apiKey, token)
        if (!session?.user) return { user: null }

        // Find existing user
        const existing = await query<{ id: number; doc: string }>(
          pool,
          `SELECT id, doc FROM data
           WHERE collection = 'users' AND doc::jsonb->>'workosId' = $1
           LIMIT 1`,
          [session.user.id],
        )

        if (existing.rows[0]) {
          const doc = JSON.parse(existing.rows[0].doc)
          return { user: { id: existing.rows[0].id, ...doc } }
        }

        // Auto-provision on first login
        const rand = crypto.getRandomValues(new Uint16Array(1))[0]
        const userData = {
          workosId: session.user.id,
          email: session.user.email,
          name: `${session.user.firstName} ${session.user.lastName}`.trim(),
          githubId: session.user.externalId ? parseInt(session.user.externalId, 10) : null,
        }

        const newUser = await query<{ id: number }>(
          pool,
          `INSERT INTO data (ns, collection, doc, rand)
           VALUES (1, 'users', $1, $2)
           RETURNING id`,
          [JSON.stringify(userData), rand],
        )

        return { user: { id: newUser.rows[0].id, ...userData } }
      } catch (err) {
        console.error('WorkOS auth error:', err)
        return { user: null }
      }
    },
  }
}

async function verifySession(apiKey: string, token: string): Promise<WorkOSSession | null> {
  const response = await fetch('https://api.workos.com/user_management/sessions/verify', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ session_token: token }),
  })

  if (!response.ok) return null
  return response.json() as Promise<WorkOSSession>
}
