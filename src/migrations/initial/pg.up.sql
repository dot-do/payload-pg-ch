CREATE TABLE ns (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uri           TEXT NOT NULL UNIQUE,
  name          TEXT,
  config        JSON,
  plan          TEXT DEFAULT 'free',

  -- hierarchy / branching
  parent        BIGINT REFERENCES ns(id),
  kind          TEXT NOT NULL DEFAULT 'production',
  ttl           INTERVAL,
  merged        TIMESTAMPTZ,
  pr            INT,

  -- WorkOS
  workosorg     TEXT,

  -- Stripe
  stripe        TEXT,
  connect       TEXT,
  subscription  TEXT,
  onboarded     BOOLEAN DEFAULT false,

  -- GitHub
  githuborgid   BIGINT,
  githubuserid  BIGINT,
  repo          TEXT,
  branch        TEXT DEFAULT 'main',
  root          TEXT DEFAULT '/',
  synced        TIMESTAMPTZ,
  commit        TEXT,

  created       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ns_uri ON ns(uri);
CREATE INDEX idx_ns_parent ON ns(parent) WHERE parent IS NOT NULL;
CREATE INDEX idx_ns_kind ON ns(kind) WHERE kind != 'production';
CREATE INDEX idx_ns_workosorg ON ns(workosorg) WHERE workosorg IS NOT NULL;
CREATE INDEX idx_ns_stripe ON ns(stripe) WHERE stripe IS NOT NULL;
CREATE INDEX idx_ns_github ON ns(githuborgid) WHERE githuborgid IS NOT NULL;
CREATE INDEX idx_ns_repo ON ns(repo) WHERE repo IS NOT NULL;
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
CREATE INDEX idx_data_collection ON data(ns, collection);
CREATE INDEX idx_data_slug ON data(ns, collection, slug);
CREATE INDEX idx_data_status ON data(status) WHERE status IS NOT NULL;
CREATE INDEX idx_data_doc ON data USING GIN (doc);
CREATE INDEX idx_data_embedding ON data USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE TABLE actions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ns            BIGINT NOT NULL REFERENCES ns(id),
  kind          TEXT NOT NULL,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  input         JSON,
  output        JSON,
  error         JSON,

  -- durable execution state
  steps         JSON NOT NULL DEFAULT '[]',
  cursor        INT NOT NULL DEFAULT 0,
  retries       INT NOT NULL DEFAULT 0,
  cap           INT NOT NULL DEFAULT 3,

  -- scheduling
  scheduled     TIMESTAMPTZ,
  started       TIMESTAMPTZ,
  completed     TIMESTAMPTZ,
  deadline      TIMESTAMPTZ,

  -- context
  parent        BIGINT REFERENCES actions(id),
  entity        BIGINT REFERENCES data(id),
  rand          INT NOT NULL,
  created       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_actions_queue ON actions(status, scheduled)
  WHERE status IN ('pending', 'running');
CREATE INDEX idx_actions_entity ON actions(entity);
CREATE INDEX idx_actions_ns ON actions(ns);
CREATE TABLE rels (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ns            BIGINT NOT NULL REFERENCES ns(id),
  "from"        BIGINT NOT NULL REFERENCES data(id) ON DELETE CASCADE,
  "to"          BIGINT NOT NULL REFERENCES data(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  sort          INT NOT NULL DEFAULT 0,
  meta          JSON,

  UNIQUE("from", path, "to")
);

CREATE INDEX idx_rels_from ON rels("from", path);
CREATE INDEX idx_rels_to ON rels("to");
CREATE INDEX idx_rels_ns ON rels(ns);
CREATE TABLE log (
  id            BIGINT GENERATED ALWAYS AS IDENTITY,
  ns            BIGINT NOT NULL,
  kind          TEXT NOT NULL,
  entity        BIGINT,
  collection    TEXT,
  actor         BIGINT,
  doc           JSONB,
  diff          JSONB,
  meta          JSONB,
  commit        TEXT,
  rand          INT NOT NULL,
  created       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created)
) PARTITION BY RANGE (created);

-- Create default partition to catch all data
CREATE TABLE log_default PARTITION OF log DEFAULT;

-- Create current month partition
CREATE TABLE log_current PARTITION OF log
  FOR VALUES FROM (date_trunc('month', now())) TO (date_trunc('month', now()) + interval '1 month');

CREATE INDEX idx_log_ns ON log(ns);
CREATE INDEX idx_log_entity ON log(entity);
CREATE INDEX idx_log_kind ON log(kind);
CREATE TABLE pending (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ns            BIGINT NOT NULL,
  entity        BIGINT NOT NULL,
  collection    TEXT NOT NULL,
  title         TEXT,
  body          TEXT,
  tags          TEXT[],
  locale        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  created       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pending_status ON pending(status) WHERE status = 'pending';
CREATE TABLE search (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ns            BIGINT NOT NULL,
  entity        BIGINT NOT NULL,
  collection    TEXT NOT NULL,
  version       BIGINT NOT NULL,
  title         TEXT,
  body          TEXT,
  tags          TEXT[],
  locale        TEXT,
  meta          JSON,
  embedding     vector(3072),
  created       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated       TIMESTAMPTZ NOT NULL DEFAULT now()
);
