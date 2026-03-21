import type { PgPool } from '../db/pg.js'
import { transaction, query } from '../db/pg.js'
import { insertSearch } from '../db/queries/search.js'

export interface IndexerConfig {
  geminiApiKey: string
  batchSize?: number
  pollIntervalMs?: number
}

interface UnindexedRow {
  seq: number
  ns: string
  type: string
  data: unknown
}

export async function runIndexerOnce(
  pool: PgPool,
  config: IndexerConfig,
): Promise<number> {
  const batchSize = config.batchSize ?? 10
  let processed = 0

  const rows = await transaction(pool, async (tx) => {
    const result = await query<UnindexedRow>(
      tx,
      `SELECT seq, ns, type, data FROM data WHERE embedding IS NULL LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batchSize],
    )
    return result.rows
  })

  for (const row of rows) {
    try {
      const doc = typeof row.data === 'string' ? JSON.parse(row.data) : row.data as Record<string, unknown>
      const title = (doc.title as string) ?? (doc.name as string) ?? null
      const body = (doc.body as string) ?? null
      const text = [title, body].filter(Boolean).join('\n')
      if (!text) {
        // No text to embed — write a zero vector so we skip it next poll
        const zeroes = new Array(768).fill(0)
        await query(pool, `UPDATE data SET embedding = $1 WHERE seq = $2`, [
          `[${zeroes.join(',')}]`,
          row.seq,
        ])
        continue
      }

      // Compute embedding via Gemini
      const embedding3072 = await computeEmbedding(config.geminiApiKey, text)

      // Truncate to 768 dims for data table
      const embedding768 = truncateAndNormalize(embedding3072, 768)

      // Update data.embedding with 768d
      await query(pool, `UPDATE data SET embedding = $1 WHERE seq = $2`, [
        `[${embedding768.join(',')}]`,
        row.seq,
      ])

      // Write to search transit table (CDC streams to ClickHouse)
      await transaction(pool, async (tx) => {
        await insertSearch(tx, {
          ns: row.ns,
          entity: row.seq,
          type: row.type,
          version: row.seq,
          name: title,
          body,
          tags: [],
          embedding: embedding3072,
        })
      })

      processed++
    } catch (err) {
      console.error(`Indexer failed for data row seq=${row.seq}:`, err)
    }
  }

  return processed
}

export function startIndexer(
  pool: PgPool,
  config: IndexerConfig,
): { stop: () => void } {
  const interval = config.pollIntervalMs ?? 5000
  let running = true

  const loop = async () => {
    while (running) {
      try {
        const count = await runIndexerOnce(pool, config)
        if (count === 0) {
          await sleep(interval)
        }
      } catch (err) {
        console.error('Indexer loop error:', err)
        await sleep(interval)
      }
    }
  }

  loop().catch(err => console.error('Indexer loop crashed:', err))

  return {
    stop() {
      running = false
    },
  }
}

async function computeEmbedding(apiKey: string, text: string): Promise<number[]> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        model: 'models/text-embedding-004',
        content: { parts: [{ text }] },
        outputDimensionality: 3072,
      }),
    },
  )

  if (!response.ok) {
    throw new Error(`Gemini embedding API error: ${response.status} ${await response.text()}`)
  }

  const data = await response.json() as { embedding: { values: number[] } }
  return data.embedding.values
}

function truncateAndNormalize(embedding: number[], dims: number): number[] {
  const truncated = embedding.slice(0, dims)
  const norm = Math.sqrt(truncated.reduce((sum, v) => sum + v * v, 0))
  if (norm === 0) return truncated
  return truncated.map(v => v / norm)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
