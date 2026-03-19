CREATE DATABASE IF NOT EXISTS cdc;

-- CDC mirror of pg.log (immutable, append-only)
CREATE TABLE cdc.log (
  id                    UInt64,
  ns                    UInt64,
  kind                  LowCardinality(String),
  entity                UInt64,
  collection            LowCardinality(String),
  actor                 UInt64,
  doc                   Nullable(String),
  diff                  Nullable(String),
  meta                  Nullable(String),
  commit                String DEFAULT '',
  rand                  UInt16,
  created               DateTime64(3),
  _peerdb_is_deleted    UInt8 DEFAULT 0,
  _peerdb_version       UInt64
) ENGINE = MergeTree()
ORDER BY (ns, entity, created)
PARTITION BY (ns, toYYYYMM(created));

-- CDC mirror of pg.data (current state, replacing)
CREATE TABLE cdc.data (
  id                    UInt64,
  ns                    UInt64,
  collection            LowCardinality(String),
  slug                  String DEFAULT '',
  doc                   String,
  status                LowCardinality(String) DEFAULT '',
  locale                LowCardinality(String) DEFAULT '',
  rand                  UInt16,
  created               DateTime64(3),
  updated               DateTime64(3),
  _peerdb_is_deleted    UInt8 DEFAULT 0,
  _peerdb_version       UInt64
) ENGINE = ReplacingMergeTree(_peerdb_version)
ORDER BY (ns, id);

-- CDC mirror of pg.actions
CREATE TABLE cdc.actions (
  id                    UInt64,
  ns                    UInt64,
  kind                  LowCardinality(String),
  name                  String,
  status                LowCardinality(String),
  input                 Nullable(String),
  output                Nullable(String),
  error                 Nullable(String),
  steps                 String DEFAULT '[]',
  cursor                UInt32,
  retries               UInt32,
  cap                   UInt32,
  scheduled             Nullable(DateTime64(3)),
  started               Nullable(DateTime64(3)),
  completed             Nullable(DateTime64(3)),
  deadline              Nullable(DateTime64(3)),
  parent                Nullable(UInt64),
  entity                Nullable(UInt64),
  rand                  UInt16,
  created               DateTime64(3),
  updated               DateTime64(3),
  _peerdb_is_deleted    UInt8 DEFAULT 0,
  _peerdb_version       UInt64
) ENGINE = ReplacingMergeTree(_peerdb_version)
ORDER BY (ns, id);

-- CDC mirror of pg.rels
CREATE TABLE cdc.rels (
  id                    UInt64,
  ns                    UInt64,
  `from`                UInt64,
  `to`                  UInt64,
  path                  String,
  sort                  UInt32,
  meta                  Nullable(String),
  _peerdb_is_deleted    UInt8 DEFAULT 0,
  _peerdb_version       UInt64
) ENGINE = ReplacingMergeTree(_peerdb_version)
ORDER BY (ns, id);

-- CDC mirror of pg.search (transit table)
CREATE TABLE cdc.search (
  id                    UInt64,
  ns                    UInt64,
  entity                UInt64,
  collection            LowCardinality(String),
  version               UInt64,
  title                 String DEFAULT '',
  body                  String DEFAULT '',
  tags                  Array(String),
  locale                LowCardinality(String) DEFAULT '',
  meta                  Nullable(String),
  embedding             Array(Float32),
  created               DateTime64(3),
  updated               DateTime64(3),
  _peerdb_is_deleted    UInt8 DEFAULT 0,
  _peerdb_version       UInt64
) ENGINE = ReplacingMergeTree(_peerdb_version)
ORDER BY (ns, entity);
-- Derived events table (materialized from cdc.log)
CREATE TABLE events (
  id            UInt64,
  ts            DateTime64(3),
  kind          LowCardinality(String),
  entity        UInt64,
  actor         UInt64,
  ns            UInt64,
  payload       String DEFAULT '',
  meta          String DEFAULT '',
  embedding     Array(Float32)
) ENGINE = MergeTree()
ORDER BY (ns, kind, entity, ts)
PARTITION BY (ns, toYYYYMM(ts));

-- Derived versions table (materialized from cdc.log)
CREATE TABLE versions (
  id            UInt64,
  entity        UInt64,
  ns            UInt64,
  version       UInt64,
  doc           String DEFAULT '',
  diff          String DEFAULT '',
  author        UInt64,
  published     UInt8 DEFAULT 0,
  commit        String DEFAULT '',
  rand          UInt16,
  created       DateTime64(3),
  embedding     Array(Float32)
) ENGINE = ReplacingMergeTree(version)
ORDER BY (ns, entity, version)
PARTITION BY (ns, toYYYYMM(created));

-- Derived search table (materialized from cdc.search)
CREATE TABLE search (
  id            UInt64,
  entity        UInt64,
  ns            UInt64,
  collection    LowCardinality(String),
  version       UInt64,
  title         String DEFAULT '',
  body          String DEFAULT '',
  tags          Array(String),
  locale        LowCardinality(String) DEFAULT '',
  meta          String DEFAULT '',
  embedding     Array(Float32),
  created       DateTime64(3),
  updated       DateTime64(3)
) ENGINE = ReplacingMergeTree(version)
ORDER BY (ns, collection, entity)
PARTITION BY (ns, toYYYYMM(updated));
-- All log entries become events
CREATE MATERIALIZED VIEW mv_log_to_events TO events AS
SELECT
  generateSnowflakeID()       AS id,
  created                     AS ts,
  kind                        AS kind,
  entity                      AS entity,
  actor                       AS actor,
  ns                          AS ns,
  coalesce(doc, '')           AS payload,
  coalesce(meta, '')          AS meta,
  []                          AS embedding
FROM cdc.log;

-- Data mutation log entries become versions
CREATE MATERIALIZED VIEW mv_log_to_versions TO versions AS
SELECT
  generateSnowflakeID()       AS id,
  entity                      AS entity,
  ns                          AS ns,
  id                          AS version,
  coalesce(doc, '')           AS doc,
  coalesce(diff, '')          AS diff,
  actor                       AS author,
  0                           AS published,
  coalesce(commit, '')        AS commit,
  rand                        AS rand,
  created                     AS created,
  []                          AS embedding
FROM cdc.log
WHERE kind IN ('data.created', 'data.updated')
  AND doc IS NOT NULL;
