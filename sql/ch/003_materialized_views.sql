-- All log entries become events
CREATE MATERIALIZED VIEW mv_log_to_events TO events AS
SELECT
  generateSnowflakeID()       AS id,
  created                     AS ts,
  kind                        AS kind,
  entity                      AS entity,
  actor                       AS actor,
  ns                          AS ns,
  coalesce(doc, '')           AS payload,
  coalesce(meta, '')          AS meta,
  []                          AS embedding
FROM cdc.log;

-- Data mutation log entries become versions
CREATE MATERIALIZED VIEW mv_log_to_versions TO versions AS
SELECT
  generateSnowflakeID()       AS id,
  entity                      AS entity,
  ns                          AS ns,
  id                          AS version,
  coalesce(doc, '')           AS doc,
  coalesce(diff, '')          AS diff,
  actor                       AS author,
  0                           AS published,
  coalesce(commit, '')        AS commit,
  rand                        AS rand,
  created                     AS created,
  []                          AS embedding
FROM cdc.log
WHERE kind IN ('data.created', 'data.updated')
  AND doc IS NOT NULL;
