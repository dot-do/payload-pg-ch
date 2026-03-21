import type { DocumentAdapter } from '../adapter.js'
import { query } from '../db/pg.js'

type Handler = (req: Request) => Promise<Response>

export interface RpcServerConfig {
  /** The local DocumentAdapter to wrap */
  adapter: DocumentAdapter
  /** Verify JWT and return the namespace it's scoped to. Throw to reject. */
  auth: (token: string) => Promise<{ ns: string; actor?: number }>
}

const METHODS = new Set([
  'ping', 'create', 'find', 'findOne', 'updateOne', 'deleteMany',
  'checkSchema', 'ensureNamespace', 'findDistinct',
])

/**
 * Create an HTTP request handler that exposes a DocumentAdapter over RPC.
 * Mount at /rpc/* on your server (Hono, Express, Next.js API route, etc.)
 *
 * Every request must include `Authorization: Bearer <jwt>`.
 * The JWT is verified via the `auth` callback which returns the scoped namespace.
 * All operations are automatically scoped to that namespace — the client cannot
 * override it.
 */
export function createRpcHandler(config: RpcServerConfig): Handler {
  const { adapter } = config

  return async (req: Request): Promise<Response> => {
    // Extract method from URL path: /rpc/{method}
    const url = new URL(req.url)
    const parts = url.pathname.split('/')
    const method = parts[parts.length - 1]

    if (!method || !METHODS.has(method)) {
      return json({ error: `Unknown method: ${method}` }, 404)
    }

    // Auth
    const authHeader = req.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return json({ error: 'Missing or invalid Authorization header' }, 401)
    }

    let session: { ns: string; actor?: number }
    try {
      session = await config.auth(authHeader.slice(7))
    } catch (e) {
      return json({ error: 'Authentication failed' }, 403)
    }

    // Parse body
    let args: Record<string, unknown> = {}
    if (req.method === 'POST') {
      try {
        args = await req.json() as Record<string, unknown>
      } catch {
        return json({ error: 'Invalid JSON body' }, 400)
      }
    }

    // Enforce namespace scoping — client cannot override ns
    if ('ns' in args) {
      args.ns = session.ns
    }
    if (session.actor != null && !('actor' in args)) {
      args.actor = session.actor
    }

    try {
      const result = await dispatch(adapter, method, args, session)
      return json(result)
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Internal error'
      console.error(`[rpc] ${method} error:`, e)
      return json({ error: message }, 500)
    }
  }
}

async function dispatch(
  adapter: DocumentAdapter,
  method: string,
  args: Record<string, unknown>,
  session: { ns: string },
): Promise<unknown> {
  switch (method) {
    case 'ping':
      return { ok: true }

    case 'create':
      return adapter.create(args as Parameters<DocumentAdapter['create']>[0])

    case 'find':
      return adapter.find(args as Parameters<DocumentAdapter['find']>[0])

    case 'findOne':
      return adapter.findOne(args as Parameters<DocumentAdapter['findOne']>[0])

    case 'updateOne':
      return adapter.updateOne(args as Parameters<DocumentAdapter['updateOne']>[0])

    case 'deleteMany':
      return adapter.deleteMany(args as Parameters<DocumentAdapter['deleteMany']>[0])

    case 'checkSchema': {
      try {
        await query(adapter.pool, 'SELECT 1 FROM data LIMIT 0', [])
        return { ok: true }
      } catch {
        return { ok: false }
      }
    }

    case 'ensureNamespace': {
      const ns = session.ns
      const existing = await query<{ seq: number }>(
        adapter.pool,
        `SELECT seq FROM data WHERE type = 'namespaces' AND ns = $1 LIMIT 1`,
        [ns],
      )
      if (existing.rows.length === 0) {
        await query(
          adapter.pool,
          `INSERT INTO data (id, ns, type, name, data, meta, rand)
           VALUES ($1, $2, 'namespaces', $3, '{}', '{"kind":"production"}', 0)`,
          [ns, ns, ns],
        )
        await adapter.nsResolver.refresh()
      }
      return { ok: true }
    }

    case 'findDistinct': {
      const ns = session.ns
      const { collection, field, limit = 10, offset = 0 } = args as {
        collection: string; field: string; limit?: number; offset?: number
      }

      const result = await query<{ value: string; total: string }>(
        adapter.pool,
        `SELECT DISTINCT data->>'${field}' AS value, count(*) OVER() AS total
         FROM data WHERE ns = $1 AND type = $2
         ORDER BY value LIMIT $3 OFFSET $4`,
        [ns, collection, limit, offset],
      )

      const total = result.rows.length > 0 ? parseInt(result.rows[0].total, 10) : 0
      return {
        values: result.rows.map(r => ({ [field]: r.value })),
        total,
      }
    }

    default:
      throw new Error(`Unknown method: ${method}`)
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
