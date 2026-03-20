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
PARTITION BY toYYYYMM(ts);

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
PARTITION BY toYYYYMM(created);

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
PARTITION BY toYYYYMM(updated);
