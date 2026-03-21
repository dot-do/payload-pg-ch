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
