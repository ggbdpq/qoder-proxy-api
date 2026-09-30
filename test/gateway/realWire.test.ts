// 真实网关 wire 样本回归：fixtures 来自 2026-09-29 真实账号抓包（已脱敏）。
// 锁定三件事：无空格 data: 前缀、reasoning_content 增量、流末 usage 信封。
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { GatewayProvider } from "../../src/providers/gateway/index.ts";
import { aggregateStream } from "../../src/core/aggregate.ts";
import type { CanonicalRequest } from "../../src/core/request.ts";
import { createFakeGateway } from "../helpers/fakeGateway.ts";

async function providerAgainstFixture(fixture: string) {
  const fake = createFakeGateway({ sseFixture: fixture });
  fake.listen(0, "127.0.0.1");
  await once(fake, "listening");
  const { port } = fake.address() as AddressInfo;
  const provider = new GatewayProvider({
    pat: "qoder_pat_fake",
    fetchImpl: (url, init) => {
      const target = new URL(url as string | URL);
      return fetch(`http://127.0.0.1:${port}${target.pathname}${target.search}`, init);
    },
    requestTimeoutMs: 5000,
  });
  return {
    provider,
    close() {
      fake.close();
    },
  };
}

const ctx = () => ({ requestId: "r", signal: new AbortController().signal });
const request: CanonicalRequest = {
  model: "Qwen3.7-Flash",
  messages: [{ role: "user", content: "只回复 OK" }],
};

test("gateway real wire: full stream aggregates text, thinking and usage", async () => {
  const { provider, close } = await providerAgainstFixture("live/success-real.sse");
  try {
    const result = await aggregateStream(provider.stream(request, ctx()));
    assert.equal(result.text, "OK");
    assert.ok(result.thinking.length > 0, "real stream carries reasoning_content");
    assert.deepEqual(result.usage, { inputTokens: 13, outputTokens: 185 });
    assert.equal(result.stopReason, "stop");
  } finally {
    close();
  }
});

test("gateway real wire: upstream metrics line is skipped, not treated as text", async () => {
  const { provider, close } = await providerAgainstFixture("live/success-real.sse");
  try {
    const result = await aggregateStream(provider.stream(request, ctx()));
    assert.ok(
      !result.text.includes("firstTokenDuration"),
      "metrics envelope must not leak into text",
    );
  } finally {
    close();
  }
});

// 失败模式样本：messages 为空时网关只回 id 信封与统计行，无任何内容。
test("gateway real wire: empty-content stream ends cleanly without text", async () => {
  const { provider, close } = await providerAgainstFixture("live/empty-messages.sse");
  try {
    const result = await aggregateStream(provider.stream(request, ctx()));
    assert.equal(result.text, "");
    assert.equal(result.stopReason, "stop");
  } finally {
    close();
  }
});
