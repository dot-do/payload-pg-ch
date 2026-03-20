import type { PgPool } from '../../db/pg.js'
import { query } from '../../db/pg.js'

export interface GitHubUser {
  id: number
  login: string
  name: string | null
  email: string | null
  avatar_url: string
}

export interface GitHubOrg {
  id: number
  login: string
  description: string | null
}

export async function fetchGitHubUser(token: string): Promise<GitHubUser> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  })
  if (!response.ok) throw new Error(`GitHub API error: ${response.status}`)
  return response.json() as Promise<GitHubUser>
}

export async function fetchGitHubOrgs(token: string): Promise<GitHubOrg[]> {
  const response = await fetch('https://api.github.com/user/orgs', {
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  })
  if (!response.ok) throw new Error(`GitHub API error: ${response.status}`)
  return response.json() as Promise<GitHubOrg[]>
}

export async function linkGitHubIdentity(
  pool: PgPool,
  userId: number,
  githubId: number,
): Promise<void> {
  await query(
    pool,
    `UPDATE data SET doc = jsonb_set(doc, '{githubId}', $1::text::jsonb), updated = now()
     WHERE id = $2 AND collection = 'users'`,
    [String(githubId), userId],
  )
}

export async function provisionOrgNamespaces(
  pool: PgPool,
  orgs: GitHubOrg[],
): Promise<void> {
  for (const org of orgs) {
    const existing = await query(
      pool,
      `SELECT id FROM ns WHERE githuborgid = $1`,
      [org.id],
    )
    if (existing.rows.length > 0) continue

    const rand = crypto.getRandomValues(new Uint16Array(1))[0]
    await query(
      pool,
      `INSERT INTO ns (uri, name, githuborgid, kind, branch)
       VALUES ($1, $2, $3, 'production', 'main')`,
      [`${org.login}.github.io`, org.login, org.id],
    )
    void rand // rand not needed for ns
  }
}

export async function resolveGitHubOrgId(
  pool: PgPool,
  nsId: number,
): Promise<number | null> {
  const result = await query<{ githuborgid: number | null }>(
    pool,
    `SELECT githuborgid FROM ns WHERE id = $1`,
    [nsId],
  )
  return result.rows[0]?.githuborgid ?? null
}
