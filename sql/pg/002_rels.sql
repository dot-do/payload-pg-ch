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
