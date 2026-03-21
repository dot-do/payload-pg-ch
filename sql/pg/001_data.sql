CREATE TABLE data (
  seq           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id            TEXT NOT NULL,
  ns            TEXT NOT NULL,
  type          TEXT NOT NULL,
  name          TEXT,
  slug          TEXT,
  url           TEXT,
  mdx           TEXT,
  data          JSONB,
  code          TEXT,
  meta          JSONB NOT NULL DEFAULT '{}',
  status        TEXT,
  locale        TEXT,
  version       BIGINT NOT NULL DEFAULT 1,
  rand          INT NOT NULL,
  created       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated       TIMESTAMPTZ NOT NULL DEFAULT now(),
  embedding     vector(768),

  UNIQUE(ns, id),
  UNIQUE(url)
);

CREATE INDEX idx_data_ns ON data(ns);
CREATE INDEX idx_data_ns_type_created ON data (ns, type, created DESC);
CREATE INDEX idx_data_slug ON data(ns, type, slug);
CREATE INDEX idx_data_status ON data(status) WHERE status IS NOT NULL;
CREATE INDEX idx_data_meta ON data USING GIN (meta);
CREATE INDEX idx_data_jsonb ON data USING GIN (data);
CREATE INDEX idx_data_embedding ON data USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
