CREATE TABLE data (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ns            BIGINT NOT NULL REFERENCES ns(id),
  collection    TEXT NOT NULL,
  slug          TEXT,
  doc           JSONB NOT NULL,
  status        TEXT,
  locale        TEXT,
  rand          INT NOT NULL,
  created       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated       TIMESTAMPTZ NOT NULL DEFAULT now(),
  embedding     vector(768)
);

CREATE INDEX idx_data_ns ON data(ns);
CREATE INDEX idx_data_ns_collection_created ON data (ns, collection, created DESC);
CREATE INDEX idx_data_slug ON data(ns, collection, slug);
CREATE INDEX idx_data_status ON data(status) WHERE status IS NOT NULL;
CREATE INDEX idx_data_embedding ON data USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
