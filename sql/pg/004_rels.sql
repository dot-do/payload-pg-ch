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
