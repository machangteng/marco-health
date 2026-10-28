import { connectWithRetry } from "../db.js";
import { asQueryable } from "../query.js";
import { defaultFixtureDir, runMockPull } from "../pull/mock.js";

async function main(): Promise<void> {
  const directory = process.argv[2] ?? defaultFixtureDir();
  const client = await connectWithRetry();
  try {
    const results = await runMockPull(asQueryable(client), directory);
    const summary = results.map((item) => {
      if (item.error) return { file: item.file, error: item.error };
      return { file: item.file, status: item.result.status, body: item.result.body };
    });
    console.log(JSON.stringify({ directory, results: summary }, null, 2));
    const failed = results.some((item) => item.error || (item.result && !item.result.ok));
    if (failed) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
