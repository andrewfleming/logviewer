# WPVIP log shipping analyzer — MVP handoff

Context for implementing this from scratch. Everything below came out of a scoping conversation, plus a docs pass against the WPVIP log field references (see "Log line parsing rules" — that section is confirmed against docs, not inferred).

## The problem

WordPress VIP has a Log Shipping feature that ships HTTP request logs (and a few other log types) to a customer's own cloud storage bucket. Customers often lack the tooling to parse or visualize what lands there, and getting internal help to set up a dashboard is unplanned work nobody prioritizes. The goal is a lightweight, self-serve log viewer that a customer (or a VIP TAM) can stand up quickly, pointed at their own bucket.

Log volume varies enormously across customers — from a handful of requests a day to tens of millions or more. The design has to hold up at both ends without different code paths per customer size.

## WPVIP Log Shipping facts (source of truth, not to be re-derived)

- Docs: https://docs.wpvip.com/logs/log-shipping/ and https://docs.wpvip.com/logs/log-shipping/cloud-bucket-requirements/
- Logs are JSON-formatted, gzipped, batched up to 50 MB or every 5 minutes, whichever comes first.
- Cloud storage providers: AWS S3, Google Cloud Storage, or Azure Blob Storage. Auth mechanism differs per provider (see "Provider auth" below).
- Log types selectable independently: HTTP request edge logs, HTTP request origin logs, Application logs, Batch logs (WordPress only), Slow query logs (WordPress only).
- Path structure (current): `${bucket}/${optional_prefix}/${log_type}/YYYY/MM/dd/...`
  - Example: `example-bucket/example-prefix/slow_query/2026/03/07/...`
- Legacy path structure (only for HTTP edge logs, before any reconfiguration): `${bucket}/${optional_prefix}/YYYY/MM/dd/...` — no `log_type` segment. A bucket that hasn't been reconfigured recently may still be on this layout for edge logs specifically.
- A test/verification file is written to the bucket root when the connection is configured: `wpvip-test-connection` (S3) or `wpvip-test-connection-[YYYY-MM-DD-HH:mm:ss]` (GCS, Azure). **The sync job must skip these** — they aren't log data.
- Multiple applications/environments can ship to the same bucket, disambiguated by the optional prefix.
- WPVIP's own docs (https://docs.wpvip.com/logs/analyze-shipped-logs/) point customers at ELK, Splunk, Datadog, or a local GoAccess run against downloaded files. None of those are "point a URL at your bucket and see a dashboard" — that gap is the opportunity.

## Platform: Spacefast

Spacefast is the hosting target. It is **not** just static hosting — it offers two additional runtimes, and this project needs one of them. Do not build the static-JS-in-browser version that was the first draft of this design; it was superseded once Functions/Database/Cron were confirmed available. Key docs:

- https://spacefast.com/docs/functions/ — the runtime this project uses
- https://spacefast.com/docs/zero-runtime/ — the *other* runtime (full-stack app + its own query language over MySQL); not used here, but documents the same underlying MySQL database
- https://spacefast.com/docs/database/
- https://spacefast.com/docs/environment-variables/
- https://spacefast.com/docs/crons/
- https://spacefast.com/docs/storage/ — **not used** for this project (see below)
- https://spacefast.com/docs/limits/

### Why Functions, not Zero, not static

- **Static-only** (the original idea) forces all cloud-storage credentials into the browser and all parsing into client JS. Rejected: no clean way to hold real S3/GCS/Azure credentials client-side without either exposing long-lived keys or building a federated-auth flow the customer has to set up themselves — which defeats "no unplanned work."
- **Zero** is a full-stack runtime with its own declarative query/mutation API over MySQL, aimed at CRUD apps with a client UI talking through generated queries. It's a reasonable alternative shape but Functions is the more direct fit: this project's actual work (fetch from S3/GCS/Azure, gunzip, parse, aggregate) is a plain server-side job, not a set of live queries against user-entered data.
- **Functions** gives a worker with outbound `fetch`, npm packages, and (when declared) a MySQL-backed `env.DB`. That's exactly the shape needed: a cron-triggered handler pulls from the bucket, aggregates, writes to `env.DB`; a second handler serves JSON to a dashboard page.

### Functions runtime facts

- Declare in `sf.jsonc`:
  ```jsonc
  {
    "$schema": "https://spacefast.com/schemas/sf.json",
    "runtime": {
      "kind": "functions",
      "database": true,
      "fetch": true,
      "compatibilityDate": "2026-07-01"
    }
  }
  ```
- `fetch: true` is required — without it, `fetch()` inside the worker is refused. There is no schema default for hand-written handlers/routers (only an OpenNext build gets it by default).
- `database: true` adds `env.DB`, a D1-shaped binding (`env.DB.prepare(sql).bind(...).all()`) over the Space's own MySQL. No connection string is ever exposed; there's no DSN anywhere.
- File router: `functions/<path>.ts` exports `GET`/`POST`/etc.; `functions/index.ts` → `/`; `functions/api/sync.ts` → `/api/sync`; etc. A single `handler.ts` at the root is also valid (whole-site catch-all) but the file-router shape is cleaner for this project (separate sync endpoint, query endpoint, dashboard).
- `context.env` inside a route handler carries the Space's environment variables (see next section). `context.params` carries route params.
- Open question to verify early: this runtime is Workers-shaped (D1-style binding, "the shape Workers already expects," OpenNext detection). It is unclear from docs how deep npm/Node-API compatibility goes. **Azure-first MVP sidesteps this entirely** — see "Provider auth."

### Environment variables (secrets)

- Docs: https://spacefast.com/docs/environment-variables/
- Set via `sf env set NAME value` (or `--value-from-stdin` to avoid shell history), or by creating `.env.server` next to the project — `sf publish` reads it, pushes every key into the Space's variables **as secrets** automatically, and never uploads the file itself.
- Caps: 64 keys total, 128 bytes per name, 16 KiB per value, 64 KiB combined. Comfortably fits any of: AWS access key + secret, an Azure SAS token, or a full GCP service-account JSON key.
- A brand-new variable is secret (write-only) by default unless `--no-secret` is passed. Secret values are never returned by any API/CLI/dashboard/log surface after creation — fine for this use case, nothing here needs to be read back.
- Runtime access: `context.env.VARNAME` in a Functions handler (second argument to `fetch`, or the `env` param the file router passes through `context`).

### Database

- Docs: https://spacefast.com/docs/database/
- Real MySQL, one per Space, shared between Zero and Functions if a Space somehow used both (it won't here — one runtime per project).
- No documented row-count or storage-size ceiling was found in the Database or Limits pages as read. **Verify directly with Spacefast** before committing to a design for the highest-volume customers (see "Volume handling" below) — don't assume unlimited.
- `sf db`, `sf db dump`, `sf db migrate` are Zero-only (they read a declared capsule schema). Since this project uses Functions, schema management is manual: raw `CREATE TABLE` via `env.DB.prepare(...)` on first run, or via the one-off SQL console (`sf db console`, mints a single-use phpMyAdmin URL — this is also the only way to inspect a Functions worker's tables from the dashboard, since the schema-aware CLI commands don't apply to Functions).

### Crons

- Docs: https://spacefast.com/docs/crons/
- Declared in `sf.jsonc`, applied on publish, max **8 per Space**:
  ```jsonc
  {
    "crons": [
      { "path": "/api/sync", "schedule": "*/15 * * * *" }
    ]
  }
  ```
- A cron is a scheduled `GET` against one of the project's own paths — same front door a visitor gets. `functions/api/sync.ts`'s `GET` handler is what runs.
- Run ceiling: 8 hours. Concurrency: at most 3 runs at once. **Overlap policy: a fire that lands while the previous one is still running is skipped, not queued.** Design the sync job to be safely re-entrant/idempotent against this — a skipped run just means the next scheduled fire picks up wherever the cursor was left.
- No retries — the next scheduled fire is the retry.
- Manual trigger for testing: `sf crons run api-cron-sync` (path gets slugged to a key) or `sf crons run /api/sync`.

### Storage (ruled out for this project)

- Docs: https://spacefast.com/docs/storage/
- This is object storage for files a *visitor* uploads through a running app (avatars, receipts, etc.), capped at **5 MiB per file**. It is not a place to stage pulled log objects and is not part of this design. Mentioned here only so it isn't confused with the MySQL database or with the customer's own cloud bucket.

## Provider auth (reading from the customer's bucket)

The worker calls out to the customer's bucket over `fetch`. Auth is server-side now (this was the hard part in the rejected static-only design; it's much less of a problem here since credentials sit in Space env vars, never in a browser):

- **Azure Blob**: customer mints a read-only SAS token scoped to the log container (parallel to how Log Shipping itself already authenticates with a SAS token on the write side). Auth is a bearer-style token on the request URL/header — simplest of the three to implement by hand if the SDK doesn't fit the runtime.
- **AWS S3**: needs SigV4-signed requests (`ListObjectsV2` + `GetObject`). Either `@aws-sdk/client-s3` if it's compatible with this runtime, or hand-rolled signing via `crypto.subtle` (SigV4 is HMAC-SHA256 based, doable without a Node-specific crypto module).
- **GCS**: either HMAC keys (S3-interoperability mode — same signing shape as AWS, so shares code with the S3 path) or a service-account JWT exchange for an OAuth2 token (more code, avoid for MVP if HMAC is available).

**MVP scope: Azure only.** Least new code (bearer SAS token, no request signing to implement) and it sidesteps the npm-compatibility unknown entirely, since no SDK is needed. Once the sync/aggregate/dashboard pipeline works end to end, add S3 (shares signing code with GCS-via-HMAC) as the second provider. GCS-via-service-account-JWT is a stretch goal, not MVP.

## Log line parsing rules (confirmed against docs)

Sources: https://docs.wpvip.com/logs/http-request-edge/ and https://docs.wpvip.com/logs/http-request-origin/

### Every field arrives as a string

Nothing is typed. The aggregator coerces on ingest:

| Field | Raw | Coerce to | Note |
| --- | --- | --- | --- |
| `status` | `"200"` | `int` | |
| `request_time` | `"0.123"` | `int` ms | **Value is in SECONDS.** ×1000, then floor to a bucket edge. |
| `body_bytes_sent` | `"4096"` | `int` | |

**A line that fails coercion is dropped.** Decided deliberately. Note the consequence: drops are silent and uncounted, so a systematic parse failure (e.g. a format change upstream) will look like a traffic dip rather than an error. If that becomes a concern, the cheapest fix is a per-run dropped-line counter — it costs one integer, not a table.

### The timestamp field name differs per log type

There is no shared field name across the two log types, so `hour_bucket` cannot be derived by a single code path. The parser needs a per-log-type field map:

| Log type | Use | Also present | Format |
| --- | --- | --- | --- |
| edge | `timestamp_iso8601` | `timestamp` | ISO 8601 UTC |
| origin | `time` | `timestamp_log` (NGINX format) | ISO 8601 UTC |

Prefer the ISO-8601 fields in both cases. The two formats diverge well beyond the timestamp, so the field map should be the general shape of the parser, not a special case bolted on for this one field.

### Edge vs. origin is not a field

It is only knowable from which `log_type` segment the object sat under in the bucket path. The `log_type` column on every rollup table carries it; nothing is parsed out of the line itself.

### Field availability

- **Both**: `status`, `request_url`, `request_time`, `body_bytes_sent`, `http_host`, `http_user_agent`, `http_referer`, `http_version`, `http_x_forwarded_for`, `request_type`, `request_id`, `remote_user`, `true_client_ip`, `wplogin`, `sent_cache_control`
- **Edge only**: `sent_x_cache` (HIT/MISS/BYPASS), `traffic_class`, `upstream_country_code`, `mobile_class`, `asn`, `http_x_ip_proxy_type`, `cache_segment`, `scheme`, `private_file`, `client_site_id`, `remote_addr`, `http_accept_language`, `content_type`, `sent_vary`, `ssl_client_verify`, `tls_version`, `tls_ja3_hash`, `tls_ja4_hash`, `ja4t_lite_hash`
- **Origin only**: `datacenter`, `stream` (stdin/stdout), `timestamp_log`

`request_url` is the path without protocol or domain. **Strip the query string before aggregating** — doubles as the top-N cardinality control and keeps values inside `VARCHAR(512)`, which real URLs with tracking params otherwise exceed.

### Encoding

The edge docs explicitly describe gzipped files of newline-delimited JSON records. The origin docs say only "a series of gzipped JSON files" and never specify NDJSON. Until a real origin sample confirms it, **the parser is tolerant**: try NDJSON first, fall back to parsing the body as a JSON array.

### `traffic_operators`

Flagged as customer-relevant and wanted in the next iteration. **It does not appear in the edge log field reference** as of this writing. `traffic_class` is confirmed and documented (*"Type of traffic for the request, as seen in our Traffic Classification metrics"*, example value `"People"`). If `traffic_operators` exists it is undocumented there — confirm against a real log sample before building against the name. The rollup schema below is designed so that adding it, if and when it turns up, is a config change rather than a migration.

## Proposed data flow

1. **Cron** fires `GET /api/sync` every 5–15 minutes (tune once real volume is known).
2. Handler reads a stored cursor from `env.DB` (last-processed object key or timestamp, per log type / per bucket config) — if no config or cursor is stored yet, this is the first run and it should backfill from "now" or a configurable start, not the entire bucket history.
3. Lists objects newer than the cursor under the relevant `log_type/YYYY/MM/dd/` prefixes (list should not need to enumerate every day ever shipped — construct the prefix from today's date, and yesterday's if crossing midnight, rather than a full bucket listing).
4. Skips any `wpvip-test-connection*` object.
5. For each new object: fetch bytes, gunzip (`DecompressionStream('gzip')` is a standard Web API and should be available in this runtime — verify), parse per "Encoding" above.
6. **Aggregate, don't store rows.** Walk each batch's lines once, updating in-memory counters for the batch, then UPSERT the deltas into rollup tables keyed by `(log_type, hour_bucket, dimension)`. Do not insert one DB row per log line — see "Volume handling."
7. Advance the cursor once the batch is fully processed (so a crashed/skipped run reprocesses the last incomplete batch rather than losing it — UPSERTs should be additive-safe or the batch should be atomic per object).
8. `GET /api/summary?range=...` reads the rollup tables and returns JSON for the dashboard.
9. A dashboard page (served by the same Functions app, or a static page that calls `/api/summary`) charts the result — status code distribution, cache hit ratio, top URLs, response-time buckets, edge vs. origin, over the selected range. GoAccess's report is a reasonable reference for what fields matter, since it's the tool WPVIP's own docs already point customers to.

## Rollup schema

Low-cardinality string dimensions share **one** table, so adding a dimension is a config change rather than a migration. See [ADR-0001](adr/0001-generic-dimension-rollup.md) for the reasoning and the trade-off accepted.

```sql
-- Any low-cardinality string dimension: status, cache, traffic_class,
-- upstream_country_code, mobile_class, ... Adding one = one config entry.
CREATE TABLE IF NOT EXISTS log_rollup_dimension (
  log_type    VARCHAR(32)  NOT NULL,
  hour_bucket DATETIME     NOT NULL,
  dimension   VARCHAR(32)  NOT NULL,  -- 'status' | 'cache' | 'traffic_class' | ...
  value       VARCHAR(255) NOT NULL,
  count       INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (log_type, hour_bucket, dimension, value)
);

-- Separate: needs its own top-N capping logic and a wider value column.
CREATE TABLE IF NOT EXISTS log_rollup_top_urls (
  log_type    VARCHAR(32)  NOT NULL,
  hour_bucket DATETIME     NOT NULL,
  url_path    VARCHAR(512) NOT NULL,  -- query string stripped before aggregating
  count       INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (log_type, hour_bucket, url_path)
  -- cap tracked URLs per hour at insert time (e.g. top 50 by running count)
);

-- Separate: numeric bucket edges, not a string dimension.
CREATE TABLE IF NOT EXISTS log_rollup_latency (
  log_type    VARCHAR(32) NOT NULL,
  hour_bucket DATETIME    NOT NULL,
  bucket_ms   INT         NOT NULL,  -- request_time seconds * 1000, floored to edge
  count       INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (log_type, hour_bucket, bucket_ms)
);

CREATE TABLE IF NOT EXISTS sync_cursor (
  source_key      VARCHAR(64) PRIMARY KEY,  -- e.g. "azure:mycontainer:http_requests_edge"
  last_object_key VARCHAR(1024),
  last_synced_at  DATETIME
);
```

Latency bucket edges (ms): `0, 50, 100, 250, 500, 1000, 2500, 5000, +`.

**Dimensions in MVP**: `status` (both log types), `cache` from `sent_x_cache` (edge only).
**Next iteration, config-only**: `traffic_class`, `upstream_country_code`, `mobile_class` — and `traffic_operators` if it proves real.

## Volume handling (the part that matters most)

Customer traffic ranges from near-zero to tens of millions of log lines a day, or more, on the same codebase. The design has to hold at both ends:

- **Rollup tables grow with time × dimension cardinality, not with traffic volume.** A quiet site and a firehose site produce the same *number* of rows per hour — the firehose site just has bigger `count` values. This is what makes the design scale without a size-tiered code path.
- **Cap dimension cardinality explicitly.** Top-N URLs must be capped (e.g. top 50 per hour) regardless of how many distinct URLs a busy site sees — otherwise `log_rollup_top_urls` does scale with traffic on a high-cardinality site. The shared `log_rollup_dimension` table is only safe for dimensions that are *inherently* low-cardinality; anything unbounded needs the top-N treatment or its own table.
- **If row-level drill-down is wanted later** (not MVP): scope it to a short rolling window (e.g. last 24h) in a separate table, pruned by its own hourly cron. At "tens of millions/day," even a 24h raw window could itself be tens of millions of rows — this is the one place aggregation doesn't help, and the part most worth confirming against Spacefast's actual (undocumented) database limits before promising it to the largest customers. Post-MVP.
- **Cron mechanics already support high-volume ingestion** without extra design work: the skip-not-queue overlap policy means a slow catch-up run on a busy day just delays the next fire rather than piling up concurrent runs against the same MySQL.

## Open questions

Resolved since the original handoff:

- ~~Do the cloud-provider SDKs run in this runtime?~~ **Sidestepped for MVP** by going Azure-only (SAS bearer token, no SDK, no signing). Returns as a live question when S3 is added.
- ~~What are the actual log line field shapes?~~ **Confirmed** — see "Log line parsing rules" above.

Still open:

1. Is there a real (if undocumented) row-count or storage-size ceiling on the per-Space MySQL? Worth asking Spacefast directly rather than discovering it under a large customer's load.
2. Does the Space's 100 GiB/day bandwidth limit (documented as a general per-Space limit) apply to the worker's *outbound* fetches to the customer's bucket, or only to traffic the Space serves to visitors? Matters for how many buckets/customers one Space could realistically sync from, if a shared multi-tenant deployment is ever considered instead of one Space per customer.
3. Does `DecompressionStream('gzip')` work as expected in this runtime, or does gunzip need a JS library fallback (e.g. `pako`)? Low risk, known fallback.
4. Are origin logs newline-delimited JSON? Undocumented. Mitigated by the tolerant parser rather than blocked on.
5. Does `traffic_operators` exist as a real field? Not in the docs. Confirm against a live sample.

## Reference links

- https://docs.wpvip.com/logs/log-shipping/
- https://docs.wpvip.com/logs/log-shipping/cloud-bucket-requirements/
- https://docs.wpvip.com/logs/analyze-shipped-logs/
- https://docs.wpvip.com/logs/http-request-edge/
- https://docs.wpvip.com/logs/http-request-origin/
- https://spacefast.com/docs/functions/
- https://spacefast.com/docs/zero-runtime/
- https://spacefast.com/docs/database/
- https://spacefast.com/docs/environment-variables/
- https://spacefast.com/docs/crons/
- https://spacefast.com/docs/storage/
- https://spacefast.com/docs/limits/
