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
