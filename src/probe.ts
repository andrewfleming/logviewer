import { TABLES, type TableName } from "./schema";

/**
 * Constructs the stream rather than checking the class exists: a runtime can
 * expose DecompressionStream and still reject 'gzip', and gzip specifically is
 * what every shipped log object is encoded with.
 */
export function detectGzipSupport(): boolean {
  try {
    new DecompressionStream("gzip");
    return true;
  } catch {
    return false;
  }
}

/** Single source of truth: the handler skips DB work on exactly this test. */
export function hasDatabaseBinding(env: Record<string, unknown> | undefined): boolean {
  return Boolean(env?.["DB"]);
}

export interface RuntimeFacts {
  env: Record<string, unknown> | undefined;
  hasGzip: boolean;
  tablesPresent: string[];
}

export interface Readout {
  envKeys: string[];
  hasDatabase: boolean;
  hasGzipStream: boolean;
  tablesPresent: TableName[];
  tablesMissing: TableName[];
  schemaComplete: boolean;
}

export function buildReadout({ env, hasGzip, tablesPresent }: RuntimeFacts): Readout {
  // Key names only. Values are secrets — a SAS token here is read access to a
  // customer's logs, and this space is served publicly.
  const envKeys = env ? Object.keys(env).sort() : [];
  const present = TABLES.filter((table) => tablesPresent.includes(table));
  const missing = TABLES.filter((table) => !tablesPresent.includes(table));

  return {
    envKeys,
    hasDatabase: hasDatabaseBinding(env),
    hasGzipStream: hasGzip,
    tablesPresent: [...present],
    tablesMissing: [...missing],
    schemaComplete: missing.length === 0,
  };
}
