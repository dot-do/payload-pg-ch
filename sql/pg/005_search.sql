-- Search index transit table.
-- Written by the indexing worker, CDC'd to ClickHouse.
CREATE TABLE search (
  seq           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ns            TEXT NOT NULL,
  entity        BIGINT NOT NULL,
  type          TEXT NOT NULL,
  version       BIGINT NOT NULL,
  name          TEXT,
  body          TEXT,
  tags          TEXT[],
  locale        TEXT,
  meta          JSONB,
  embedding     vector(3072),
  created       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_search_ns_type ON search (ns, type);
CREATE INDEX idx_search_entity ON search (ns, entity);
