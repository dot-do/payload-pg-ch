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
