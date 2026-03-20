import type { PgPool } from '../../db/pg.js'
import { query } from '../../db/pg.js'
import { createBranch, mergeBranch, cleanupBranch } from '../../ns/branch.js'
import { emit } from '../../db/queries/log.js'
import type { NsRow } from '../../types.js'

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
  const parentResult = await query<NsRow>(
    pool,
    `SELECT * FROM ns WHERE repo = $1 AND kind = 'production' LIMIT 1`,
    [repo],
  )
  const parent = parentResult.rows[0]
  if (!parent) return

  switch (event.action) {
    case 'opened':
    case 'reopened': {
      const previewUri = `${parent.uri}/pr/${pr}`
      // Check if preview already exists
      const existing = await query(pool, `SELECT id FROM ns WHERE uri = $1`, [previewUri])
      if (existing.rows.length > 0) return

      await createBranch(pool, {
        parent: parent.id,
        uri: previewUri,
        name: `PR #${pr}: ${branch}`,
        branch,
        kind: 'preview',
        ttl: '7 days',
        pr,
        repo: parent.repo ?? undefined,
        root: parent.root,
        githuborgid: parent.githuborgid,
      })

      await emit(pool, {
        ns: parent.id,
        kind: 'preview.created',
        meta: { pr, branch, uri: previewUri },
      })
      break
    }

    case 'closed': {
      const previewUri = `${parent.uri}/pr/${pr}`
      const previewResult = await query<NsRow>(pool, `SELECT * FROM ns WHERE uri = $1`, [previewUri])
      const preview = previewResult.rows[0]
      if (!preview) return

      if (event.pull_request.merged) {
        await mergeBranch(pool, preview.id)
        await emit(pool, {
          ns: parent.id,
          kind: 'branch.merged',
          meta: { pr, branch, uri: previewUri },
        })
      }

      await cleanupBranch(pool, preview.id)
      await emit(pool, {
        ns: parent.id,
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
  const nsResult = await query<NsRow>(
    pool,
    `SELECT * FROM ns WHERE repo = $1 AND branch = $2`,
    [repo, branch],
  )

  for (const ns of nsResult.rows) {
    await emit(pool, {
      ns: ns.id,
      kind: 'github.push',
      meta: { commit: event.after, branch },
    })
    // Actual sync is triggered by a worker that watches for these events
  }
}
