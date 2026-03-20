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

CREATE INDEX idx_search_ns_collection ON search (ns, collection);
CREATE INDEX idx_search_entity ON search (ns, entity);
