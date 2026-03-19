import type pg from 'pg'
import { transaction, query } from '../db/pg.js'
import { dequeuePending, completePending, failPending } from '../db/queries/pending.js'
import { insertSearch } from '../db/queries/search.js'

export interface IndexerConfig {
  geminiApiKey: string
  batchSize?: number
  pollIntervalMs?: number
}

export async function runIndexerOnce(
  pool: pg.Pool,
  config: IndexerConfig,
): Promise<number> {
  const batchSize = config.batchSize ?? 10
  let processed = 0

  const rows = await transaction(pool, async (tx) => {
    return dequeuePending(tx, batchSize)
  })

  for (const row of rows) {
    try {
      const text = [row.title, row.body].filter(Boolean).join('\n')
      if (!text) {
        await completePending(pool, row.id)
        continue
      }

      // Compute embedding via Gemini
      const embedding3072 = await computeEmbedding(config.geminiApiKey, text)

      // Truncate to 768 dims for data table
      const embedding768 = truncateAndNormalize(embedding3072, 768)

      // Update data.embedding with 768d
      await query(pool, `UPDATE data SET embedding = $1 WHERE id = $2`, [
        `[${embedding768.join(',')}]`,
        row.entity,
      ])

      // Get version for search table
      const versionResult = await query<{ id: number }>(
        pool,
        `SELECT id FROM data WHERE id = $1`,
        [row.entity],
      )
      const version = versionResult.rows[0]?.id ?? 0

      // Write to search transit table (CDC streams to ClickHouse)
      await transaction(pool, async (tx) => {
        await insertSearch(tx, {
          ns: row.ns,
          entity: row.entity,
          collection: row.collection,
          version,
          title: row.title,
          body: row.body,
          tags: row.tags,
          locale: row.locale,
          embedding: embedding3072,
        })
      })

      await completePending(pool, row.id)
      processed++
    } catch (err) {
      console.error(`Indexer failed for pending ${row.id}:`, err)
      await failPending(pool, row.id)
    }
  }

  return processed
}

export function startIndexer(
  pool: pg.Pool,
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

  loop()

  return {
    stop() {
      running = false
    },
  }
}

async function computeEmbedding(apiKey: string, text: string): Promise<number[]> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
