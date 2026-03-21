import type { PgPool } from '../../db/pg.js'
import type { DataRow } from '../../types.js'
import { query } from '../../db/pg.js'

export interface GitHubSyncConfig {
  token: string
}

export async function pullFromGitHub(
  pool: PgPool,
  nsDoc: DataRow,
  config: GitHubSyncConfig,
): Promise<{ commit: string; changed: number }> {
  const meta = nsDoc.meta as Record<string, unknown> | null
  if (!meta?.repo) throw new Error(`No repo configured for ns ${nsDoc.ns}`)

  const repo = meta.repo as string
  const branch = (meta.branch as string) ?? 'main'
  const root = (meta.root as string) ?? '/'
  const since = (meta.commit as string) ?? ''
  const [owner, repoName] = repo.split('/')

  // Fetch commits since last sync
  const url = since
    ? `https://api.github.com/repos/${owner}/${repoName}/compare/${since}...${branch}`
    : `https://api.github.com/repos/${owner}/${repoName}/commits?sha=${branch}&per_page=1`

  const response = await fetch(url, {
    headers: {
      'Authorization': `token ${config.token}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  })

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`)
  }

  const data = await response.json() as {
    commits?: Array<{ sha: string }>
    files?: Array<{ filename: string; status: string; raw_url: string }>
  } | Array<{ sha: string }>

  let latestCommit = since
  let changed = 0

  if (Array.isArray(data)) {
    // Single commit response
    latestCommit = data[0]?.sha ?? latestCommit
  } else if (data.files) {
    // Compare response
    latestCommit = data.commits?.[data.commits.length - 1]?.sha ?? latestCommit

    for (const file of data.files) {
      // Only process files under root
      if (!file.filename.startsWith(root.replace(/^\//, ''))) continue

      if (file.status === 'removed') {
        // Delete from data table
        await query(pool,
          `DELETE FROM data WHERE ns = $1 AND slug = $2`,
          [nsDoc.ns, file.filename],
        )
      } else {
        // Fetch file content
        const contentRes = await fetch(file.raw_url, {
          headers: { 'Authorization': `token ${config.token}` },
        })
        const content = await contentRes.text()

        // Parse content and upsert
        const doc = parseFileContent(file.filename, content)
        const existing = await query(pool,
          `SELECT seq FROM data WHERE ns = $1 AND slug = $2`,
          [nsDoc.ns, file.filename],
        )

        if (existing.rows.length > 0) {
          await query(pool,
            `UPDATE data SET data = $1, updated = now() WHERE ns = $2 AND slug = $3`,
            [JSON.stringify(doc), nsDoc.ns, file.filename],
          )
        } else {
          const rand = crypto.getRandomValues(new Uint16Array(1))[0]
          await query(pool,
            `INSERT INTO data (ns, type, slug, data, rand)
             VALUES ($1, $2, $3, $4, $5)`,
            [nsDoc.ns, inferType(file.filename), file.filename, JSON.stringify(doc), rand],
          )
        }
      }
      changed++
    }
  }

  // Update namespace doc sync state
  await query(pool,
    `UPDATE data SET meta = meta::jsonb || $1::jsonb, updated = now()
     WHERE type = 'namespaces' AND ns = $2`,
    [JSON.stringify({ commit: latestCommit, synced: new Date().toISOString() }), nsDoc.ns],
  )

  return { commit: latestCommit, changed }
}

export async function pushToGitHub(
  _pool: PgPool,
  nsDoc: DataRow,
  _config: GitHubSyncConfig,
): Promise<{ commit: string; changed: number }> {
  const meta = nsDoc.meta as Record<string, unknown> | null
  if (!meta?.repo) throw new Error(`No repo configured for ns ${nsDoc.ns}`)

  // TODO: Implement push logic
  // 1. Query modified docs since last sync
  // 2. Serialize to file format
  // 3. Create tree + commit via GitHub API
  // 4. Push to branch

  return { commit: '', changed: 0 }
}

function parseFileContent(filename: string, content: string): Record<string, unknown> {
  if (filename.endsWith('.json')) {
    return JSON.parse(content)
  }

  // Parse markdown with frontmatter
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (match) {
    const frontmatter = parseFrontmatter(match[1])
    return { ...frontmatter, content: match[2].trim() }
  }

  return { content, title: filename.split('/').pop()?.replace(/\.[^.]+$/, '') }
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const line of raw.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim()
      result[key] = value
    }
  }
  return result
}

function inferType(filename: string): string {
  const parts = filename.split('/')
  if (parts.length >= 2) return parts[0]
  return 'pages'
}
