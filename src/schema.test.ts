import { describe, expect, it } from "vitest";
import { DDL, TABLES, ddlStatements } from "./schema";

describe("rollup schema", () => {
  it("defines exactly the four tables the MVP needs", () => {
    expect([...TABLES].sort()).toEqual([
      "log_rollup_dimension",
      "log_rollup_latency",
      "log_rollup_top_urls",
      "sync_cursor",
    ]);
  });

  it("is idempotent by construction, so repeated requests cannot fail on re-create", () => {
    for (const statement of ddlStatements()) {
      expect(statement).toMatch(/CREATE TABLE IF NOT EXISTS/i);
    }
  });

  it("keys the shared dimension table by dimension, per ADR-0001", () => {
    // Without `dimension` in the key, two dimensions sharing an hour bucket
    // would collide and silently overwrite each other's counts.
    expect(DDL.log_rollup_dimension).toMatch(
      /PRIMARY KEY\s*\(\s*log_type\s*,\s*hour_bucket\s*,\s*dimension\s*,\s*value\s*\)/i,
    );
  });

  it("keeps unbounded and numeric rollups out of the shared dimension table", () => {
    // ADR-0001's guardrail: the shared table is only safe for inherently
    // low-cardinality string dimensions.
    expect(DDL.log_rollup_top_urls).toMatch(/url_path/i);
    expect(DDL.log_rollup_latency).toMatch(/bucket_ms/i);
    expect(DDL.log_rollup_dimension).not.toMatch(/url_path|bucket_ms/i);
  });

  it("gives top URLs room for real WPVIP paths", () => {
    expect(DDL.log_rollup_top_urls).toMatch(/url_path\s+VARCHAR\(512\)/i);
  });

  it("emits one statement per table", () => {
    expect(ddlStatements()).toHaveLength(TABLES.length);
  });
});
