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

test("parseEnvFile accepts blank Xiaomi placeholders and does not return them", () => {
  const parsed = parseEnvFile(`
DATABASE_URL=postgres://marco:marco@localhost:5432/marco_health
XIAOMI_USER_ID=
XIAOMI_PASS_TOKEN=
XIAOMI_DEVICE_ID=
`);
  assert.equal(parsed.DATABASE_URL, "postgres://marco:marco@localhost:5432/marco_health");
  assert.equal(Object.keys(parsed).join(","), "DATABASE_URL");
});

test("parseEnvFile rejects keys other than the documented set", () => {
  assert.throws(
    () => parseEnvFile("DATABASE_URL=postgres://localhost/marco_health\nOTHER_SETTING=nope\n"),
    /DATABASE_URL/,
  );
});

test("parseEnvFile rejects a credential stored in .env without echoing it", () => {
  const secret = "should-not-appear-in-the-error";
  assert.throws(
    () => parseEnvFile(`DATABASE_URL=postgres://localhost/marco_health\nXIAOMI_PASS_TOKEN=${secret}\n`),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(secret), false);
      assert.match(error.message, /process environment/);
      return true;
    },
  );
});

test("describeDatabaseUrl omits the password", () => {
  const described = describeDatabaseUrl("postgres://marco:s3cret@localhost:5432/marco_health");
  assert.equal(described, "localhost:5432/marco_health");
  assert.equal(described.includes("s3cret"), false);
});

test(".env.example documents DATABASE_URL and blank Xiaomi placeholders", () => {
  const text = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(text, /^DATABASE_URL=\S+/m);
  assert.match(text, /^XIAOMI_USER_ID=\s*$/m);
  assert.match(text, /^XIAOMI_PASS_TOKEN=\s*$/m);
  assert.match(text, /^XIAOMI_DEVICE_ID=\s*$/m);
  for (const line of text.split("\n")) {
    if (!line.startsWith("XIAOMI_")) continue;
    assert.match(line, /^XIAOMI_[A-Z_]+=\s*$/);
  }
});
