export const TABLES = [
  "log_rollup_dimension",
  "log_rollup_top_urls",
  "log_rollup_latency",
  "sync_cursor",
] as const;

export type TableName = (typeof TABLES)[number];

export const DDL: Record<TableName, string> = {
  // One table for every inherently low-cardinality string dimension, so adding
  // traffic_class or upstream_country_code later is a config entry rather than
  // a migration. See docs/adr/0001-generic-dimension-rollup.md.
  log_rollup_dimension: `
    CREATE TABLE IF NOT EXISTS log_rollup_dimension (
      log_type    VARCHAR(32)  NOT NULL,
      hour_bucket DATETIME     NOT NULL,
      dimension   VARCHAR(32)  NOT NULL,
      value       VARCHAR(255) NOT NULL,
      count       INT          NOT NULL DEFAULT 0,
      PRIMARY KEY (log_type, hour_bucket, dimension, value)
    )
  `,

  // Separate: cardinality grows with traffic, so this one needs top-N capping
  // at insert time and a wider value column than the shared table allows.
  log_rollup_top_urls: `
    CREATE TABLE IF NOT EXISTS log_rollup_top_urls (
      log_type    VARCHAR(32)  NOT NULL,
      hour_bucket DATETIME     NOT NULL,
      url_path    VARCHAR(512) NOT NULL,
      count       INT          NOT NULL DEFAULT 0,
      PRIMARY KEY (log_type, hour_bucket, url_path)
    )
  `,

  // Separate: ordered numeric buckets, queried as a histogram rather than as
  // a set of labels.
  log_rollup_latency: `
    CREATE TABLE IF NOT EXISTS log_rollup_latency (
      log_type    VARCHAR(32) NOT NULL,
      hour_bucket DATETIME    NOT NULL,
      bucket_ms   INT         NOT NULL,
      count       INT         NOT NULL DEFAULT 0,
      PRIMARY KEY (log_type, hour_bucket, bucket_ms)
    )
  `,

  sync_cursor: `
    CREATE TABLE IF NOT EXISTS sync_cursor (
      source_key      VARCHAR(64) PRIMARY KEY,
      last_object_key VARCHAR(1024),
      last_synced_at  DATETIME
    )
  `,
};

export function ddlStatements(): string[] {
  return TABLES.map((table) => DDL[table].trim());
}
