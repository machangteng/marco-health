import test from "node:test";
import assert from "node:assert/strict";
import { errorMessage } from "./health.js";

test("errorMessage reads nested connection failures", () => {
  const error = new AggregateError([
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }),
  ]);
  assert.match(errorMessage(error), /ECONNREFUSED 127\.0\.0\.1:5432/);
});
