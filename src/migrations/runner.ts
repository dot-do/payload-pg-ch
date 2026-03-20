import type { PgPool } from '../db/pg.js'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { query, transaction } from '../db/pg.js'

export interface MigrationMeta {
  name: string
  created: string
  requires_resync: boolean
  affects: string[]
  notes?: string
}

export interface CHConfig {
  host: string
  port: number
  database: string
}

export class MigrationRunner {
  private pg: PgPool
  private ch?: CHConfig

  constructor(pg: PgPool, ch?: CHConfig) {
    this.pg = pg
    this.ch = ch
  }

  async ensureMigrationsTable(): Promise<void> {
    await query(this.pg, `
      CREATE TABLE IF NOT EXISTS migrations (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        batch INT NOT NULL DEFAULT 1,
        created TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
  }

  async run(migrationDir: string): Promise<void> {
    await this.ensureMigrationsTable()

    const metaPath = join(migrationDir, 'meta.json')
    let meta: MigrationMeta
    try {
      meta = JSON.parse(await readFile(metaPath, 'utf-8'))
    } catch {
      meta = { name: migrationDir.split('/').pop()!, created: new Date().toISOString(), requires_resync: false, affects: [] }
    }

    // Check if already applied
    const applied = await query<{ name: string }>(this.pg, `SELECT name FROM migrations WHERE name = $1`, [meta.name])
    if (applied.rows.length > 0) return

    // Get current batch number
    const batchResult = await query<{ batch: number }>(this.pg, `SELECT COALESCE(MAX(batch), 0) + 1 AS batch FROM migrations`)
    const batch = batchResult.rows[0].batch

    // 1. Run PG migration
    const pgSqlPath = join(migrationDir, 'pg.up.sql')
    try {
      const pgSql = await readFile(pgSqlPath, 'utf-8')
      if (pgSql.trim()) {
        await transaction(this.pg, async (tx) => {
          await query(tx, pgSql)
          await query(tx, `INSERT INTO migrations (name, batch) VALUES ($1, $2)`, [meta.name, batch])
        })
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }

    // 2. Run CH migration
    if (this.ch) {
      const chSqlPath = join(migrationDir, 'ch.up.sql')
      try {
        const chSql = await readFile(chSqlPath, 'utf-8')
        if (chSql.trim()) {
          await this.executeClickHouse(chSql)
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }

    // 3. Refresh foreign tables if CH schema changed
    if (this.ch && meta.affects.some(a => a.startsWith('ch.'))) {
      await this.refreshForeignTables()
    }
  }

  async rollback(migrationDir: string): Promise<void> {
    await this.ensureMigrationsTable()

    const metaPath = join(migrationDir, 'meta.json')
    let meta: MigrationMeta
    try {
      meta = JSON.parse(await readFile(metaPath, 'utf-8'))
    } catch {
      meta = { name: migrationDir.split('/').pop()!, created: new Date().toISOString(), requires_resync: false, affects: [] }
    }

    // CH down first
    if (this.ch) {
      const chDownPath = join(migrationDir, 'ch.down.sql')
      try {
        const chSql = await readFile(chDownPath, 'utf-8')
        if (chSql.trim()) {
          await this.executeClickHouse(chSql)
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }

    // PG down
    const pgDownPath = join(migrationDir, 'pg.down.sql')
    try {
      const pgSql = await readFile(pgDownPath, 'utf-8')
      if (pgSql.trim()) {
        await transaction(this.pg, async (tx) => {
          await query(tx, pgSql)
          await query(tx, `DELETE FROM migrations WHERE name = $1`, [meta.name])
        })
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  async status(): Promise<{ applied: string[]; pending: string[] }> {
    await this.ensureMigrationsTable()
    const result = await query<{ name: string }>(this.pg, `SELECT name FROM migrations ORDER BY created`)
    return {
      applied: result.rows.map(r => r.name),
      pending: [], // Would compare against migration directory listing
    }
  }

  async runAll(migrationsRoot: string): Promise<void> {
    const entries = await readdir(migrationsRoot, { withFileTypes: true })
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort()

    for (const dir of dirs) {
      await this.run(join(migrationsRoot, dir))
    }
  }

  private async executeClickHouse(sql: string): Promise<void> {
    if (!this.ch) return
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean)
    for (const stmt of statements) {
      const url = `http://${this.ch.host}:${this.ch.port}/?database=${this.ch.database}`
      const response = await fetch(url, {
        method: 'POST',
        body: stmt,
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(`ClickHouse error: ${response.status} ${text}`)
      }
    }
  }

  async refreshForeignTables(): Promise<void> {
    if (!this.ch) return
    await query(this.pg, `
      DROP SCHEMA IF EXISTS ch CASCADE;
      CREATE SCHEMA ch;
      IMPORT FOREIGN SCHEMA "default"
        LIMIT TO (events, versions, search)
        FROM SERVER clickhouse INTO ch;
    `)
  }
}
