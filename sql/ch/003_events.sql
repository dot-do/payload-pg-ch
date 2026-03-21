-- ==========================================================================
-- events: unified event stream with ULID IDs
-- Two sources: data mutations (via MV from versions) + non-mutation events (CDC from PG events)
-- ==========================================================================

CREATE TABLE events (
  id            String DEFAULT generateULID(),
  ts            DateTime64(3),
  kind          LowCardinality(String),
  entity        UInt64 DEFAULT 0,
  ns            String,
  type          LowCardinality(String) DEFAULT '',
  actor         UInt64 DEFAULT 0,
  doc           String DEFAULT '',
  data          String DEFAULT '{}',
  meta          String DEFAULT '{}',
  source        LowCardinality(String) DEFAULT 'cdc'
) ENGINE = MergeTree()
ORDER BY (ns, kind, ts)
PARTITION BY toYYYYMM(ts);

-- Data mutations → events
CREATE MATERIALIZED VIEW mv_versions_to_events TO events AS
SELECT
  generateULID()        AS id,
  updated               AS ts,
  multiIf(
    _peerdb_is_deleted = 1, 'data.deleted',
    version = 1,             'data.created',
                             'data.updated'
  )                     AS kind,
  seq                   AS entity,
  ns                    AS ns,
  type                  AS type,
  0                     AS actor,
  mdx                   AS doc,
  data                  AS data,
  meta                  AS meta,
  'cdc'                 AS source
FROM versions;

-- CDC landing for PG events table (non-mutation events)
CREATE TABLE cdc_events (
  seq                   UInt64,
  ns                    String,
  kind                  LowCardinality(String),
  entity                UInt64 DEFAULT 0,
  type                  LowCardinality(String) DEFAULT '',
  actor                 UInt64 DEFAULT 0,
  data                  Nullable(String),
  meta                  Nullable(String),
  created               DateTime64(3),
  _peerdb_is_deleted    UInt8 DEFAULT 0,
  _peerdb_version       UInt64
) ENGINE = MergeTree()
ORDER BY (ns, kind, created)
PARTITION BY toYYYYMM(created);

-- Non-mutation events → unified events
CREATE MATERIALIZED VIEW mv_cdc_events_to_events TO events AS
SELECT
  generateULID()            AS id,
  created                   AS ts,
  kind, entity, ns, type, actor,
  ''                        AS doc,
  coalesce(data, '{}')      AS data,
  coalesce(meta, '{}')      AS meta,
  'app'                     AS source
FROM cdc_events;
