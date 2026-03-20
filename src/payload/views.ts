import type { PgPool } from '../db/pg.js'
import { query } from '../db/pg.js'

/**
 * Validate that a DDL parameter contains only safe characters
 * (alphanumeric, dots, hyphens, underscores) to prevent SQL injection
 * in interpolated DDL statements where parameterized queries aren't possible.
 */
function sanitizeDDLParam(value: string, paramName: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid ${paramName}: must contain only alphanumeric characters, dots, hyphens, and underscores`)
  }
  return value
}

export async function refreshForeignTables(
  pool: PgPool,
  clickhouseHost: string = 'localhost',
  clickhousePort: number = 9440,
  clickhouseDb: string = 'default',
): Promise<void> {
  const safeHost = sanitizeDDLParam(clickhouseHost, 'clickhouseHost')
  const safePort = sanitizeDDLParam(String(clickhousePort), 'clickhousePort')
  const safeDb = sanitizeDDLParam(clickhouseDb, 'clickhouseDb')

  // Create server if not exists
  await query(pool, `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_foreign_server WHERE srvname = 'clickhouse') THEN
        CREATE SERVER clickhouse
          FOREIGN DATA WRAPPER pg_clickhouse
          OPTIONS (host '${safeHost}', port '${safePort}', dbname '${safeDb}');
      END IF;
    END $$;
  `)

  // Recreate schema and import
  await query(pool, `DROP SCHEMA IF EXISTS ch CASCADE`)
  await query(pool, `CREATE SCHEMA ch`)
  await query(pool, `
    IMPORT FOREIGN SCHEMA "${safeDb}"
      LIMIT TO (events, versions, search)
      FROM SERVER clickhouse INTO ch
  `)

  // Recreate views
  await createViews(pool)
}

async function createViews(pool: PgPool): Promise<void> {
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
