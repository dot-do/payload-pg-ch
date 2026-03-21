-- ==========================================================================
-- versions: CDC landing from PG data table (append-only)
-- Every INSERT/UPDATE/DELETE in PG data becomes a row here.
-- PeerDB mirror: pg.data → ch.versions
-- ==========================================================================

CREATE TABLE versions (
  seq                   UInt64,
  id                    String,
  ns                    String,
  type                  LowCardinality(String),
  name                  String DEFAULT '',
  slug                  String DEFAULT '',
  url                   String DEFAULT '',
  mdx                   String DEFAULT '',
  data                  String DEFAULT '{}',
  code                  String DEFAULT '',
  meta                  String DEFAULT '{}',
  status                LowCardinality(String) DEFAULT '',
  locale                LowCardinality(String) DEFAULT '',
  version               UInt64,
  rand                  UInt16,
  created               DateTime64(3),
  updated               DateTime64(3),
  embedding             Array(Float32),
  _peerdb_is_deleted    UInt8 DEFAULT 0,
  _peerdb_version       UInt64
) ENGINE = MergeTree()
ORDER BY (ns, seq, _peerdb_version)
PARTITION BY toYYYYMM(updated);
-- ==========================================================================
-- data: current state, derived from versions via ReplacingMergeTree
-- ==========================================================================

CREATE TABLE data (
  seq                   UInt64,
  id                    String,
  ns                    String,
  type                  LowCardinality(String),
  name                  String DEFAULT '',
  slug                  String DEFAULT '',
  url                   String DEFAULT '',
  mdx                   String DEFAULT '',
  data                  String DEFAULT '{}',
  code                  String DEFAULT '',
  meta                  String DEFAULT '{}',
  status                LowCardinality(String) DEFAULT '',
  locale                LowCardinality(String) DEFAULT '',
  version               UInt64,
  rand                  UInt16,
  created               DateTime64(3),
  updated               DateTime64(3),
  embedding             Array(Float32),
  _peerdb_is_deleted    UInt8 DEFAULT 0,
  _peerdb_version       UInt64
) ENGINE = ReplacingMergeTree(_peerdb_version)
ORDER BY (ns, seq);

CREATE MATERIALIZED VIEW mv_versions_to_data TO data AS
SELECT * FROM versions;
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
-- ==========================================================================
-- search: full-text + vector search index (CDC from PG search table)
-- ==========================================================================

CREATE TABLE search (
  seq                   UInt64,
  ns                    String,
  entity                UInt64,
  type                  LowCardinality(String),
  version               UInt64,
  name                  String DEFAULT '',
  body                  String DEFAULT '',
  tags                  Array(String),
  locale                LowCardinality(String) DEFAULT '',
  meta                  String DEFAULT '{}',
  embedding             Array(Float32),
  created               DateTime64(3),
  updated               DateTime64(3),
  _peerdb_is_deleted    UInt8 DEFAULT 0,
  _peerdb_version       UInt64
) ENGINE = ReplacingMergeTree(_peerdb_version)
ORDER BY (ns, type, entity)
PARTITION BY toYYYYMM(updated);

-- CDC mirrors for rels and actions (analytics)

CREATE TABLE rels (
  seq                   UInt64,
  ns                    String,
  `from`                UInt64,
  `to`                  UInt64,
  path                  String,
  sort                  UInt32,
  meta                  Nullable(String),
  _peerdb_is_deleted    UInt8 DEFAULT 0,
  _peerdb_version       UInt64
) ENGINE = ReplacingMergeTree(_peerdb_version)
ORDER BY (ns, seq);

CREATE TABLE actions (
  seq                   UInt64,
  id                    String,
  ns                    String,
  type                  LowCardinality(String),
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
ORDER BY (ns, seq);
