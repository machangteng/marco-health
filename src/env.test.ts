import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { describeDatabaseUrl, parseEnvFile } from "./env.js";

test("parseEnvFile accepts DATABASE_URL and comments", () => {
  const parsed = parseEnvFile(`
# local only
DATABASE_URL="postgres://marco:marco@localhost:5432/marco_health"
`);
  assert.equal(parsed.DATABASE_URL, "postgres://marco:marco@localhost:5432/marco_health");
});

test("parseEnvFile rejects keys other than DATABASE_URL", () => {
  assert.throws(
    () => parseEnvFile("DATABASE_URL=postgres://localhost/marco_health\nOTHER_SETTING=nope\n"),
    /DATABASE_URL/,
  );
});

test("describeDatabaseUrl omits the password", () => {
  const described = describeDatabaseUrl("postgres://marco:s3cret@localhost:5432/marco_health");
  assert.equal(described, "localhost:5432/marco_health");
  assert.equal(described.includes("s3cret"), false);
});

test(".env.example documents DATABASE_URL only", () => {
  const text = readFileSync(new URL("../.env.example", import.meta.url), "utf8").trim();
  assert.match(text, /^DATABASE_URL=\S+$/);
  assert.equal(text.includes("PASS"), false);
  assert.equal(text.includes("TOKEN"), false);
});
