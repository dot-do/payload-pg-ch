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
CREATE TABLE rels (
  seq           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ns            TEXT NOT NULL,
  "from"        BIGINT NOT NULL REFERENCES data(seq) ON DELETE CASCADE,
  "to"          BIGINT NOT NULL REFERENCES data(seq) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  sort          INT NOT NULL DEFAULT 0,
  meta          JSONB,

  UNIQUE("from", path, "to")
);

CREATE INDEX idx_rels_from ON rels("from", path);
CREATE INDEX idx_rels_to ON rels("to");
CREATE INDEX idx_rels_ns ON rels(ns);
CREATE TABLE actions (
  seq           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id            TEXT NOT NULL,
  ns            TEXT NOT NULL,
  kind          TEXT NOT NULL,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  input         JSONB,
  output        JSONB,
  error         JSONB,

  -- durable execution state
  steps         JSONB NOT NULL DEFAULT '[]',
  cursor        INT NOT NULL DEFAULT 0,
  retries       INT NOT NULL DEFAULT 0,
  cap           INT NOT NULL DEFAULT 3,

  -- scheduling
  scheduled     TIMESTAMPTZ,
  started       TIMESTAMPTZ,
  completed     TIMESTAMPTZ,
  deadline      TIMESTAMPTZ,

  -- context
  parent        BIGINT REFERENCES actions(seq),
  entity        BIGINT REFERENCES data(seq),
  rand          INT NOT NULL,
  created       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_actions_queue ON actions(status, scheduled)
  WHERE status IN ('pending', 'running');
CREATE INDEX idx_actions_entity ON actions(entity);
CREATE INDEX idx_actions_ns ON actions(ns);
-- Non-mutation events (page views, analytics, webhooks).
-- Mutation events are captured by CDC on the data table.
-- CDC'd to ClickHouse and pruned aggressively.
CREATE TABLE events (
  seq           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ns            TEXT NOT NULL,
  kind          TEXT NOT NULL,
  entity        BIGINT,
  type          TEXT,
  actor         BIGINT,
  data          JSONB,
  meta          JSONB,
  created       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_ns_kind ON events(ns, kind);
CREATE INDEX idx_events_created ON events(created);
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
