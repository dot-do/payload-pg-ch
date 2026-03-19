import type pg from 'pg'
import { query } from '../../src/db/pg.js'

export async function seedTestData(pool: pg.Pool): Promise<{
  nsId: number
  branchNsId: number
  userId: number
  postId: number
  categoryId: number
}> {
  // Create production namespace
  const nsResult = await query<{ id: number }>(
    pool,
    `INSERT INTO ns (uri, name, kind, branch)
     VALUES ('test.local', 'Test', 'production', 'main')
     RETURNING id`,
  )
  const nsId = nsResult.rows[0].id

  // Create branch namespace
  const branchResult = await query<{ id: number }>(
    pool,
    `INSERT INTO ns (uri, name, kind, parent, branch, ttl)
     VALUES ('test.local/pr/1', 'PR #1', 'preview', $1, 'feat/test', '7 days')
     RETURNING id`,
    [nsId],
  )
  const branchNsId = branchResult.rows[0].id

  // Create a user
  const userResult = await query<{ id: number }>(
    pool,
    `INSERT INTO data (ns, collection, doc, rand)
     VALUES ($1, 'users', '{"name":"Test User","email":"test@test.local"}', 12345)
     RETURNING id`,
    [nsId],
  )
  const userId = userResult.rows[0].id

  // Create a category
  const catResult = await query<{ id: number }>(
    pool,
    `INSERT INTO data (ns, collection, slug, doc, rand)
     VALUES ($1, 'categories', 'tech', '{"title":"Technology","slug":"tech"}', 23456)
     RETURNING id`,
    [nsId],
  )
  const categoryId = catResult.rows[0].id

  // Create a post
  const postResult = await query<{ id: number }>(
    pool,
    `INSERT INTO data (ns, collection, slug, doc, status, rand)
     VALUES ($1, 'posts', 'hello-world', '{"title":"Hello World","body":"Content here","slug":"hello-world"}', 'published', 34567)
     RETURNING id`,
    [nsId],
  )
  const postId = postResult.rows[0].id

  // Create relationship: post → user (author)
  await query(
    pool,
    `INSERT INTO rels (ns, "from", "to", path, sort)
     VALUES ($1, $2, $3, 'author', 0)`,
    [nsId, postId, userId],
  )

  // Create relationship: post → category
  await query(
    pool,
    `INSERT INTO rels (ns, "from", "to", path, sort)
     VALUES ($1, $2, $3, 'categories.0', 0)`,
    [nsId, postId, categoryId],
  )

  // Create a log entry
  await query(
    pool,
    `INSERT INTO log (ns, kind, entity, collection, actor, doc, rand)
     VALUES ($1, 'data.created', $2, 'posts', $3, '{"title":"Hello World"}', 34567)`,
    [nsId, postId, userId],
  )

  return { nsId, branchNsId, userId, postId, categoryId }
}
