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
