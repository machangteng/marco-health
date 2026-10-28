import { appendFileSync } from "node:fs";
import { connectWithRetry } from "../db.js";
import { maskSecrets } from "../mask.js";
import { probeWindow } from "../pull/live-probe.js";
import { asQueryable } from "../query.js";
import { formatLivePullVerify, queryLivePullVerify } from "../verify/live-pull.js";

/**
 * After pull:live, prove Asia/Shanghai today (the pull window end) has
 * daily_aggregates rows. Prints counts only. Exits 1 when a read would be fixture.
 */
async function main(): Promise<void> {
  const day = probeWindow(new Date()).to;
  const client = await connectWithRetry();
  try {
    const result = await queryLivePullVerify(asQueryable(client), day);
    const line = formatLivePullVerify(result);
    console.log(line);
    writeSummary(line);
    if (!result.ok) {
      console.error(line);
      if (process.env.GITHUB_ACTIONS === "true") {
        console.error(`::error title=live pull verify::${line}`);
      }
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

function runtimeSecrets(): string[] {
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  const values: string[] = [];
  if (databaseUrl !== "") values.push(databaseUrl);
  if (databaseUrl === "") return values;
  try {
    const password = new URL(databaseUrl).password;
    if (password === "") return values;
    values.push(password);
    try {
      const decoded = decodeURIComponent(password);
      if (decoded !== "") values.push(decoded);
    } catch {
      // The raw password component is already listed.
    }
  } catch {
    // The raw DATABASE_URL is already listed.
  }
  return values;
}

function writeSummary(line: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    appendFileSync(summaryPath, `${line}\n`);
  } catch {
    // The line is already on stdout. A step-summary write must not hide the verify result.
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(maskSecrets(message, runtimeSecrets()));
  process.exit(1);
});
