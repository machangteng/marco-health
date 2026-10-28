import { connectWithRetry } from "../db.js";
import { maskSecrets } from "../mask.js";
import { asQueryable } from "../query.js";
import { publicProbeView, runLiveProbe } from "../pull/live-probe.js";
import { persistLiveProbe } from "../pull/persist.js";

async function main(): Promise<void> {
  const secrets = [process.env.XIAOMI_PASS_TOKEN ?? ""].filter((value) => value !== "");
  const result = await runLiveProbe({
    env: process.env,
    log: (line) => console.error(maskSecrets(line, secrets)),
  });
  if (result.skipped) {
    console.log(JSON.stringify(publicProbeView(result)));
    return;
  }
  const client = await connectWithRetry();
  try {
    await persistLiveProbe(asQueryable(client), result);
  } finally {
    await client.end();
  }
  console.log(JSON.stringify(publicProbeView(result)));
  if (result.status === "failed") process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const secrets = [process.env.XIAOMI_PASS_TOKEN ?? ""].filter((value) => value !== "");
  console.error(maskSecrets(message, secrets));
  process.exit(1);
});