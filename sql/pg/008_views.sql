-- pg_clickhouse foreign data wrapper setup
-- Run after ClickHouse schema is created and PeerDB CDC is active

CREATE SERVER IF NOT EXISTS clickhouse
  FOREIGN DATA WRAPPER pg_clickhouse
  OPTIONS (host 'localhost', port '9440', dbname 'default');

DROP SCHEMA IF EXISTS ch CASCADE;
CREATE SCHEMA ch;

IMPORT FOREIGN SCHEMA "default"
  LIMIT TO (events, versions, search)
  FROM SERVER clickhouse
  INTO ch;

-- Events view: enriches ClickHouse events with collection for sqid prefix
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
LEFT JOIN data d ON d.id = e.entity AND d.ns = e.ns;

-- Versions view: enriches with document metadata
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
LEFT JOIN data d ON d.id = v.entity AND d.ns = v.ns;

-- Search view: pass-through
CREATE OR REPLACE VIEW search_view AS
SELECT * FROM ch.search;
