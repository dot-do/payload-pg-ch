import type { PgPool } from '../../db/pg.js'
import { query } from '../../db/pg.js'
import { createBranch, mergeBranch, cleanupBranch } from '../../ns/branch.js'
import { emit } from '../../db/queries/events.js'
import type { DataRow } from '../../types.js'

export interface GitHubWebhookConfig {
  webhookSecret: string
}

interface PREvent {
  action: string
  number: number
  pull_request: {
    head: { ref: string }
    base: { ref: string }
    merged: boolean
  }
  repository: {
    full_name: string
  }
}

interface PushEvent {
  ref: string
  after: string
  repository: {
    full_name: string
  }
}

export async function handlePullRequest(
  pool: PgPool,
  event: PREvent,
): Promise<void> {
  const repo = event.repository.full_name
  const pr = event.number
  const branch = event.pull_request.head.ref

  // Find the production namespace for this repo
  const parentResult = await query<DataRow>(
    pool,
    `SELECT * FROM data WHERE type = 'namespaces' AND meta->>'kind' = 'production' AND meta->>'repo' = $1 LIMIT 1`,
    [repo],
  )
  const parent = parentResult.rows[0]
  if (!parent) return

  switch (event.action) {
    case 'opened':
    case 'reopened': {
      const previewNs = `${parent.ns}/pr/${pr}`
      // Check if preview already exists
      const existing = await query(pool, `SELECT seq FROM data WHERE type = 'namespaces' AND ns = $1`, [previewNs])
      if (existing.rows.length > 0) return

      await createBranch(pool, {
        parentNs: parent.ns,
        ns: previewNs,
        name: `PR #${pr}: ${branch}`,
        branch,
        kind: 'preview',
        ttl: '7 days',
        pr,
      })

      await emit(pool, {
        ns: parent.ns,
        kind: 'preview.created',
        meta: { pr, branch, ns: previewNs },
      })
      break
    }

    case 'closed': {
      const previewNs = `${parent.ns}/pr/${pr}`
      const previewResult = await query<DataRow>(pool, `SELECT * FROM data WHERE type = 'namespaces' AND ns = $1`, [previewNs])
      const preview = previewResult.rows[0]
      if (!preview) return

      if (event.pull_request.merged) {
        await mergeBranch(pool, previewNs)
        await emit(pool, {
          ns: parent.ns,
          kind: 'branch.merged',
          meta: { pr, branch, ns: previewNs },
        })
      }

      await cleanupBranch(pool, previewNs)
      await emit(pool, {
        ns: parent.ns,
        kind: 'preview.cleaned',
        meta: { pr, branch },
      })
      break
    }
  }
}

export async function handlePush(
  pool: PgPool,
  event: PushEvent,
): Promise<void> {
  const repo = event.repository.full_name
  const branch = event.ref.replace('refs/heads/', '')

  // Find namespaces tracking this repo+branch
  const nsResult = await query<DataRow>(
    pool,
    `SELECT * FROM data WHERE type = 'namespaces' AND meta->>'repo' = $1 AND meta->>'branch' = $2`,
    [repo, branch],
  )

  for (const nsDoc of nsResult.rows) {
    await emit(pool, {
      ns: nsDoc.ns,
      kind: 'github.push',
      meta: { commit: event.after, branch },
    })
    // Actual sync is triggered by a worker that watches for these events
  }
}
