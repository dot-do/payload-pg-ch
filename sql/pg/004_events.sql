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
