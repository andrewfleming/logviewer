# ADR-0001: One generic rollup table for low-cardinality dimensions

- **Status**: Accepted
- **Date**: 2026-09-25

## Context

The MVP rolls up shipped WPVIP logs into hourly counters. The original design sketched one table per dimension — `log_rollup_status`, then `log_rollup_cache` once `sent_x_cache` was added to scope.

Several more dimensions are already known to be wanted, and were named as customer-relevant for the *next* iteration rather than MVP: `traffic_class`, and possibly `traffic_operators` (which is not in the published edge field reference and needs confirming against a live sample). Beyond those, the edge log carries `upstream_country_code`, `mobile_class`, `asn`, and `http_x_ip_proxy_type` — all bounded-cardinality and all plausible future charts.

Under one-table-per-dimension, each of those is a new `CREATE TABLE`, a new UPSERT path in the sync handler, and a new branch in `/api/summary`. Since schema management on Spacefast Functions is manual (raw `CREATE TABLE` via `env.DB` — `sf db migrate` is Zero-only), every added dimension is hand-written migration code against a live table.

## Decision

Low-cardinality string dimensions share a single table, keyed by a `dimension` discriminator:

```sql
CREATE TABLE log_rollup_dimension (
  log_type    VARCHAR(32)  NOT NULL,
  hour_bucket DATETIME     NOT NULL,
  dimension   VARCHAR(32)  NOT NULL,
  value       VARCHAR(255) NOT NULL,
  count       INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (log_type, hour_bucket, dimension, value)
);
```

Adding a dimension becomes one entry in a config map (`log field name` → `dimension key`, per log type). No DDL, no new UPSERT path, no new summary branch.

Two rollups stay in their own tables because they are not low-cardinality string dimensions:

- **`log_rollup_top_urls`** — unbounded cardinality. Needs top-N capping logic at insert time and a `VARCHAR(512)` value column. Putting it in the shared table would let one busy site's URL space swamp every other dimension.
- **`log_rollup_latency`** — numeric bucket edges, queried as an ordered histogram rather than a set of labels.

## Consequences

**Gained**: the stated requirement — `traffic_class` and friends become config, not migrations. Also means the *next* iteration doesn't have to touch the sync handler's write path at all, which is the part most at risk of subtle breakage since it runs under a skip-not-queue cron with additive UPSERTs.

**Given up**: `status` is stored as a string in `value VARCHAR(255)` rather than as `SMALLINT`. Numeric range queries (`WHERE status_code >= 500`) become `WHERE dimension = 'status' AND value LIKE '5%'`, or a cast. Accepted because the dashboard charts distributions over a fixed, tiny set of status codes rather than doing numeric range scans, and because status codes are effectively an enum in practice.

**Guardrail**: the shared table is only safe for dimensions that are *inherently* bounded. Anything whose distinct-value count grows with traffic needs the top-N treatment or its own table. A dimension added to the config map without checking this is the one way this design fails, and it fails on the busiest customers first.
