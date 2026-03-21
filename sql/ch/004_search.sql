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
