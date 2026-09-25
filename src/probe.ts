import { TABLES } from "./schema";

export interface RuntimeFacts {
  env: Record<string, unknown> | undefined;
  hasGzip: boolean;
  tablesPresent: string[];
}

export interface Readout {
  envKeys: string[];
  hasDatabase: boolean;
  hasGzipStream: boolean;
  tablesPresent: string[];
  tablesMissing: string[];
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
    hasDatabase: Boolean(env && "DB" in env),
    hasGzipStream: hasGzip,
    tablesPresent: [...present],
    tablesMissing: [...missing],
    schemaComplete: missing.length === 0,
  };
}
