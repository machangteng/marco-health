import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestBatch, type IngestResult } from "../ingest/batch.js";
import type { Queryable } from "../query.js";

export type FixtureBatch = {
  file: string;
  batch: unknown | null;
};

export function defaultFixtureDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/mi_health");
}

/** Read ingest batches from fixtures/mi_health. No network and no credentials. */
export async function readFixtureBatches(directory: string): Promise<FixtureBatch[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const batches: FixtureBatch[] = [];
  for (const name of names) {
    const text = await readFile(resolve(directory, name), "utf8");
    try {
      batches.push({ file: name, batch: JSON.parse(text) as unknown });
    } catch {
      batches.push({ file: name, batch: null });
    }
  }
  return batches;
}

export type MockPullFileResult =
  | { file: string; error: "parse_error"; result?: undefined }
  | { file: string; error?: undefined; result: IngestResult };

export async function runMockPull(client: Queryable, directory: string): Promise<MockPullFileResult[]> {
  const files = await readFixtureBatches(directory);
  const results: MockPullFileResult[] = [];
  for (const file of files) {
    if (file.batch === null) {
      results.push({ file: file.file, error: "parse_error" });
      continue;
    }
    const result = await ingestBatch(client, file.batch, { meta: { mode: "mock" } });
    results.push({ file: file.file, result });
  }
  return results;
}
