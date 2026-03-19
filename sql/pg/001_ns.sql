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
