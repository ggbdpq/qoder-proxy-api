import test from "node:test";
import assert from "node:assert/strict";
import { ERROR_CODES, ProviderError } from "../../src/core/errors.ts";

test("errors: ProviderError carries machine-readable code", () => {
  const error = new ProviderError("PROVIDER_RATE_LIMITED", "upstream 429", {
    status: 429,
  });
  assert.equal(error.code, "PROVIDER_RATE_LIMITED");
  assert.equal(error.status, 429);
  assert.equal(error.message, "upstream 429");
  assert.equal(error instanceof Error, true);
});

test("errors: canonical code set is closed", () => {
  assert.deepEqual(Object.keys(ERROR_CODES).sort(), [
    "MODEL_NOT_FOUND",
    "PROVIDER_ABORTED",
    "PROVIDER_AUTH_ERROR",
    "PROVIDER_PROTOCOL_ERROR",
    "PROVIDER_RATE_LIMITED",
    "PROVIDER_TIMEOUT",
    "PROVIDER_UNAVAILABLE",
    "UNSUPPORTED_CAPABILITY",
  ]);
});
