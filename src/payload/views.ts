import type pg from 'pg'
import { query } from '../db/pg.js'

export async function refreshForeignTables(
  pool: pg.Pool,
  clickhouseHost: string = 'localhost',
  clickhousePort: number = 9440,
  clickhouseDb: string = 'default',
): Promise<void> {
  // Create server if not exists
  await query(pool, `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_foreign_server WHERE srvname = 'clickhouse') THEN
        CREATE SERVER clickhouse
          FOREIGN DATA WRAPPER pg_clickhouse
          OPTIONS (host '${clickhouseHost}', port '${clickhousePort}', dbname '${clickhouseDb}');
      END IF;
    END $$;
  `)

  // Recreate schema and import
  await query(pool, `DROP SCHEMA IF EXISTS ch CASCADE`)
  await query(pool, `CREATE SCHEMA ch`)
  await query(pool, `
    IMPORT FOREIGN SCHEMA "${clickhouseDb}"
      LIMIT TO (events, versions, search)
      FROM SERVER clickhouse INTO ch
  `)

  // Recreate views
  await createViews(pool)
}

async function createViews(pool: pg.Pool): Promise<void> {
  await query(pool, `
    CREATE OR REPLACE VIEW events AS
    SELECT
      e.id,
      e.ts,
      e.kind,
      e.entity,
      e.actor,
      e.ns,
      e.payload,
      e.meta,
      d.collection
    FROM ch.events e
    LEFT JOIN data d ON d.id = e.entity AND d.ns = e.ns
  `)

  await query(pool, `
    CREATE OR REPLACE VIEW versions AS
    SELECT
      v.id,
      v.entity,
      v.ns,
      v.version,
      v.doc,
      v.diff,
      v.author,
      v.published,
      v.commit,
      v.rand,
      v.created,
      d.collection
    FROM ch.versions v
    LEFT JOIN data d ON d.id = v.entity AND d.ns = v.ns
  `)

  await query(pool, `
    CREATE OR REPLACE VIEW search_view AS
    SELECT * FROM ch.search
  `)
}
