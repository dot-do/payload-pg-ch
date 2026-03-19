CREATE TABLE log (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ns            BIGINT NOT NULL REFERENCES ns(id),
  kind          TEXT NOT NULL,
  entity        BIGINT,
  collection    TEXT,
  actor         BIGINT,
  doc           JSON,
  diff          JSON,
  meta          JSON,
  commit        TEXT,
  rand          INT NOT NULL,
  created       TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (created);

CREATE INDEX idx_log_ns ON log(ns);
CREATE INDEX idx_log_entity ON log(entity);
CREATE INDEX idx_log_kind ON log(kind);
