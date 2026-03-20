import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, teardownTestPool } from './setup.js'
import { query } from '../src/db/pg.js'
import { MigrationRunner } from '../src/migrations/runner.js'
import { generateMigration } from '../src/migrations/generator.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type pg from 'pg'

let pool: pg.Pool
let runner: MigrationRunner
let tempDir: string

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  runner = new MigrationRunner(pool)
})

afterAll(async () => {
  await teardownTestPool()
})

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'migrations-'))
  // Drop migrations table to start fresh
  await query(pool, `DROP TABLE IF EXISTS migrations`)
  await query(pool, `DROP TABLE IF EXISTS test_migration, test_idempotent, test_rollback, test_step1, test_step2`)
})

describe('MigrationRunner', () => {
  it('creates migrations table', async () => {
    await runner.ensureMigrationsTable()

    const result = await query(pool, `SELECT 1 FROM pg_tables WHERE tablename = 'migrations'`)
    expect(result.rows).toHaveLength(1)
  })

  it('runs a PG migration', async () => {
    const migrationDir = await generateMigration({
      name: 'add_test_table',
      migrationsRoot: tempDir,
      pgUp: 'CREATE TABLE test_migration (id SERIAL PRIMARY KEY, name TEXT);',
      pgDown: 'DROP TABLE IF EXISTS test_migration;',
    })

    await runner.run(migrationDir)

    // Table should exist
    const result = await query(pool, `SELECT 1 FROM pg_tables WHERE tablename = 'test_migration'`)
    expect(result.rows).toHaveLength(1)

    // Migration should be recorded
    const status = await runner.status()
    expect(status.applied).toContain(migrationDir.split('/').pop())

    // Cleanup
    await query(pool, `DROP TABLE IF EXISTS test_migration`)
  })

  it('skips already-applied migration', async () => {
    const migrationDir = await generateMigration({
      name: 'idempotent_test',
      migrationsRoot: tempDir,
      pgUp: 'CREATE TABLE test_idempotent (id SERIAL PRIMARY KEY);',
      pgDown: 'DROP TABLE IF EXISTS test_idempotent;',
    })

    await runner.run(migrationDir)
    await runner.run(migrationDir) // Should not throw

    const status = await runner.status()
    const name = migrationDir.split('/').pop()!
    expect(status.applied.filter(a => a === name)).toHaveLength(1)

    await query(pool, `DROP TABLE IF EXISTS test_idempotent`)
  })

  it('rolls back a migration', async () => {
    const migrationDir = await generateMigration({
      name: 'rollback_test',
      migrationsRoot: tempDir,
      pgUp: 'CREATE TABLE test_rollback (id SERIAL PRIMARY KEY);',
      pgDown: 'DROP TABLE IF EXISTS test_rollback;',
    })

    await runner.run(migrationDir)
    await runner.rollback(migrationDir)

    // Table should be gone
    const result = await query(pool, `SELECT 1 FROM pg_tables WHERE tablename = 'test_rollback'`)
    expect(result.rows).toHaveLength(0)
  })

  it('runAll executes migrations in order', async () => {
    await generateMigration({
      name: 'step_1',
      migrationsRoot: tempDir,
      pgUp: 'CREATE TABLE test_step1 (id SERIAL PRIMARY KEY);',
      pgDown: 'DROP TABLE IF EXISTS test_step1;',
    })
    await generateMigration({
      name: 'step_2',
      migrationsRoot: tempDir,
      pgUp: 'CREATE TABLE test_step2 (id SERIAL PRIMARY KEY);',
      pgDown: 'DROP TABLE IF EXISTS test_step2;',
    })

    await runner.runAll(tempDir)

    const status = await runner.status()
    expect(status.applied).toHaveLength(2)

    await query(pool, `DROP TABLE IF EXISTS test_step1, test_step2`)
  })
})

describe('generateMigration', () => {
  it('creates migration directory with all files', async () => {
    const dir = await generateMigration({
      name: 'test_gen',
      migrationsRoot: tempDir,
      pgUp: 'SELECT 1;',
      pgDown: 'SELECT 1;',
      chUp: '-- CH up',
      chDown: '-- CH down',
      requiresResync: true,
      affects: ['pg.data'],
      notes: 'Test migration',
    })

    const { readFileSync } = await import('node:fs')
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8'))
    expect(meta.requires_resync).toBe(true)
    expect(meta.affects).toContain('pg.data')
    expect(meta.notes).toBe('Test migration')

    const pgUp = readFileSync(join(dir, 'pg.up.sql'), 'utf-8')
    expect(pgUp).toBe('SELECT 1;')
  })
})
