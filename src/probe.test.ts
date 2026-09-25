import { describe, expect, it } from "vitest";
import { buildReadout, detectGzipSupport, hasDatabaseBinding } from "./probe";

const SECRET = "sv=2021-08-06&sig=THIS_MUST_NEVER_APPEAR";

describe("gzip detection", () => {
  it("answers whether gzip specifically works, not whether the class exists", () => {
    // A runtime can expose DecompressionStream and still reject 'gzip'.
    // Every shipped log object is gzipped, so the format is the question.
    expect(detectGzipSupport()).toBe(true);
  });

  it("reports false rather than throwing when the format is unsupported", () => {
    const original = globalThis.DecompressionStream;
    // @ts-expect-error -- deliberately simulating a runtime that rejects gzip
    globalThis.DecompressionStream = class {
      constructor() {
        throw new TypeError("Unsupported compression format");
      }
    };

    try {
      expect(detectGzipSupport()).toBe(false);
    } finally {
      globalThis.DecompressionStream = original;
    }
  });
});

describe("runtime readout", () => {
  it("never serialises an environment variable's value", () => {
    // This space is published publicly and holds a customer's SAS token.
    // Leaking a value here would hand out read access to their logs.
    const readout = buildReadout({
      env: { AZURE_SAS_TOKEN: SECRET, DB: {} },
      hasGzip: true,
      tablesPresent: [],
    });

    expect(JSON.stringify(readout)).not.toContain("THIS_MUST_NEVER_APPEAR");
  });

  it("still reports which environment keys are present, by name", () => {
    const readout = buildReadout({
      env: { AZURE_SAS_TOKEN: SECRET, DB: {} },
      hasGzip: true,
      tablesPresent: [],
    });

    expect(readout.envKeys).toContain("AZURE_SAS_TOKEN");
  });

  it("reports whether the database binding was actually provided", () => {
    expect(buildReadout({ env: { DB: {} }, hasGzip: true, tablesPresent: [] }).hasDatabase).toBe(true);
    expect(buildReadout({ env: {}, hasGzip: true, tablesPresent: [] }).hasDatabase).toBe(false);
  });

  it("reports gzip support, which decides whether a JS fallback is needed", () => {
    expect(buildReadout({ env: {}, hasGzip: false, tablesPresent: [] }).hasGzipStream).toBe(false);
  });

  it("names the tables still missing rather than just counting them", () => {
    const readout = buildReadout({
      env: { DB: {} },
      hasGzip: true,
      tablesPresent: ["log_rollup_dimension", "sync_cursor"],
    });

    expect(readout.schemaComplete).toBe(false);
    expect(readout.tablesMissing).toEqual(["log_rollup_top_urls", "log_rollup_latency"]);
  });

  it("reports a complete schema once every table exists", () => {
    const readout = buildReadout({
      env: { DB: {} },
      hasGzip: true,
      tablesPresent: [
        "log_rollup_dimension",
        "log_rollup_top_urls",
        "log_rollup_latency",
        "sync_cursor",
      ],
    });

    expect(readout.schemaComplete).toBe(true);
    expect(readout.tablesMissing).toEqual([]);
  });

  it("does not claim a binding the handler would decline to use", () => {
    // The handler skips all DB work when DB is absent or undefined. If the
    // readout disagreed, it would report a capability that same request
    // just refused to exercise.
    expect(hasDatabaseBinding({ DB: undefined })).toBe(false);
    expect(buildReadout({ env: { DB: undefined }, hasGzip: true, tablesPresent: [] }).hasDatabase).toBe(
      false,
    );
  });

  it("tolerates a runtime that provides no env object at all", () => {
    const readout = buildReadout({ env: undefined, hasGzip: false, tablesPresent: [] });

    expect(readout.envKeys).toEqual([]);
    expect(readout.hasDatabase).toBe(false);
  });
});
