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
