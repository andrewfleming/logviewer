import { buildReadout, detectGzipSupport, hasDatabaseBinding } from "./src/probe";
import { ddlStatements } from "./src/schema";

interface PreparedStatement {
  all(): Promise<unknown>;
  run?(): Promise<unknown>;
}

interface DatabaseBinding {
  prepare(sql: string): PreparedStatement;
}

interface Env {
  DB?: DatabaseBinding;
  [key: string]: unknown;
}

/** Method names on the binding, so first contact reports the real API surface. */
function surfaceOf(binding: object): string[] {
  const names = new Set<string>();
  for (let o = binding; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Object.getOwnPropertyNames(o)) {
      if (key !== "constructor") names.add(key);
    }
  }
  return [...names].sort();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function discoverTables(db: DatabaseBinding): Promise<string[]> {
  const result = (await db.prepare("SHOW TABLES").all()) as unknown;
  const rows = Array.isArray(result)
    ? result
    : ((result as { results?: unknown[] })?.results ?? []);

  // MySQL names the SHOW TABLES column after the schema, so read values
  // positionally rather than guessing the key.
  return rows
    .map((row) => (row && typeof row === "object" ? Object.values(row)[0] : row))
    .filter((name): name is string => typeof name === "string");
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const diagnostics: Record<string, unknown> = {};

    // Decides whether the sync job can use the platform gunzip or needs a JS
    // fallback. Issue #1 exists largely to answer this.
    const hasGzip = detectGzipSupport();

    let tablesPresent: string[] = [];

    if (hasDatabaseBinding(env) && env.DB) {
      diagnostics.databaseSurface = surfaceOf(env.DB);

      try {
        for (const statement of ddlStatements()) {
          // DDL is not a SELECT; D1-shaped bindings expect run() for those.
          const prepared = env.DB.prepare(statement);
          await (prepared.run ? prepared.run() : prepared.all());
        }
        diagnostics.ddlApplied = true;
      } catch (error) {
        diagnostics.ddlApplied = false;
        diagnostics.ddlError = messageOf(error);
      }

      try {
        tablesPresent = await discoverTables(env.DB);
      } catch (error) {
        diagnostics.tableDiscoveryError = messageOf(error);
      }
    }

    const readout = buildReadout({ env, hasGzip, tablesPresent });

    return new Response(JSON.stringify({ ...readout, diagnostics }, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },
};
