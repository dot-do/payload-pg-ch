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
