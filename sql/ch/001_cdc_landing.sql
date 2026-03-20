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
PARTITION BY toYYYYMM(created);

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
