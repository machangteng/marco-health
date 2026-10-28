import { appendFileSync } from "node:fs";
import { connectWithRetry } from "../db.js";
import { maskSecrets } from "../mask.js";
import { asQueryable } from "../query.js";
import { authDiagnosticsLine, livePullExitCode, livePullSummary, runLiveProbe } from "../pull/live-probe.js";
import { persistLiveProbe } from "../pull/persist.js";

/**
 * Daily stack X pull used by `npm run pull:live` and `npm run pull:probe`.
 * Missing credentials exit 1 with credentials_absent. Failures do not load fixtures.
 */
async function main(): Promise<void> {
  const secrets = runtimeSecrets();
  const result = await runLiveProbe({
    env: process.env,
    log: (line) => console.error(maskSecrets(line, secrets)),
  });
  const summary = livePullSummary(result);
  console.log(JSON.stringify(summary));
  if (result.skipped) {
    note("credentials_absent", false);
    process.exitCode = 1;
    return;
  }
  try {
    const client = await connectWithRetry();
    try {
      await persistLiveProbe(asQueryable(client), result);
    } finally {
      await client.end();
    }
  } catch (error) {
    note("ingest_failed", false);
    throw error;
  }
  const exitCode = livePullExitCode(result);
  if (exitCode !== 0) note(result.error_code ?? "unknown", false, authDiagnosticsLine(summary));
  else note(result.status, true);
  process.exitCode = exitCode;
}

function runtimeSecrets(): string[] {
  const values = [process.env.XIAOMI_USER_ID, process.env.XIAOMI_PASS_TOKEN, process.env.XIAOMI_DEVICE_ID];
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    try {
      const password = new URL(databaseUrl).password;
      if (password !== "") values.push(password);
    } catch {
      // DATABASE_URL is validated when a connection is opened.
    }
  }
  return values.map((value) => value?.trim() ?? "").filter((value) => value !== "");
}

function note(code: string, ok: boolean, diagnostics = ""): void {
  const detail = diagnostics === "" ? "" : ` ${diagnostics}`;
  const line = ok ? `live pull ${code}` : `live pull failed: ${code}${detail}`;
  if (!ok) {
    console.error(line);
    if (process.env.GITHUB_ACTIONS === "true") console.error(`::error title=live pull::${line}`);
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    appendFileSync(summaryPath, `${line}\n`);
  } catch {
    // The result is already on stdout. A step-summary write must not hide the pull outcome.
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(maskSecrets(message, runtimeSecrets()));
  process.exit(1);
});
