// CloudAgentsProvider 行为测试：合同套件 + 与旧 runTurn 路径的差分对照。
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { CloudAgentsProvider } from "../../src/providers/cloudAgents/index.ts";
import { CloudAgentsClient, SessionStore } from "../../src/providers/cloudAgents/client.ts";
import { aggregateStream } from "../../src/core/aggregate.ts";
import { ProviderError } from "../../src/core/errors.ts";
import type { CanonicalRequest } from "../../src/core/request.ts";
import type { TextDeltaEvent, MessageEndEvent, ErrorEvent } from "../../src/core/events.ts";
import { runProviderContract } from "../contracts/providerContract.ts";
import { createFakeCloud } from "../helpers/fakeCloud.ts";

interface StartProviderOptions {
  fixture?: string;
  createSessionStatus?: number;
  holdStream?: boolean;
}

async function startProvider({
  fixture = "deltas.sse",
  createSessionStatus = 200,
  holdStream = false,
}: StartProviderOptions = {}) {
  const fake = createFakeCloud({ fixture, createSessionStatus, holdStream });
  fake.listen(0, "127.0.0.1");
  await once(fake, "listening");
  const { port } = fake.address() as AddressInfo;
  const provider = new CloudAgentsProvider({
    client: new CloudAgentsClient({
      baseUrl: `http://127.0.0.1:${port}/api/v1/cloud`,
      accessToken: "tok",
      requestTimeoutMs: 5000,
    }),
    sessionStore: new SessionStore({ ttlMs: 60000 }),
    modelMap: {
      cc: {
        modelId: "cc",
        agentId: "agent_test_123456",
        environmentId: "env_test_654321",
        title: "test",
        metadata: {},
      },
    },
    archiveEphemeralSessions: true,
  });
  return {
    provider,
    fake,
    close() {
      fake.close();
    },
  };
}

const ccRequest = (extra: Partial<CanonicalRequest> = {}): CanonicalRequest => ({
  model: "cc",
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

test("contract: cloudAgents provider satisfies the provider contract", async () => {
  const { provider, close } = await startProvider();
  try {
    await runProviderContract({
      provider,
      scenarios: {
        stream: {
          request: ccRequest(),
          expect(events) {
            assert.deepEqual(
              events.map((event) => event.type),
              ["message.start", "text.delta", "text.delta", "message.end"],
            );
            assert.equal((events[1] as TextDeltaEvent).text, "Hello");
            assert.equal((events[2] as TextDeltaEvent).text, ", world");
            assert.equal((events[3] as MessageEndEvent).stopReason, "stop");
          },
        },
        unsupported: { request: ccRequest({ tools: [{ name: "t", inputSchema: {} }] }) },
      },
    });
  } finally {
    close();
  }
});

test("cloudAgents: aggregation matches legacy runTurn output (differential)", async () => {
  const { provider, fake, close } = await startProvider();
  try {
    const legacy = await provider.client.runTurn({ sessionId: "sess_direct", prompt: "hi" });
    const result = await aggregateStream(
      provider.stream(ccRequest(), { requestId: "r1", signal: new AbortController().signal }),
    );
    assert.equal(result.text, legacy);
    assert.equal(result.text, "Hello, world");
    assert.ok(fake.state.streamRequests >= 1);
  } finally {
    close();
  }
});

test("cloudAgents: same conversationId reuses one session, different ids do not", async () => {
  const { provider, fake, close } = await startProvider();
  const ctx = (conversationId: string) => ({
    requestId: conversationId,
    conversationId,
    signal: new AbortController().signal,
  });
  try {
    for (let i = 0; i < 2; i += 1) {
      await aggregateStream(provider.stream(ccRequest(), ctx("conv-1")));
    }
    await aggregateStream(provider.stream(ccRequest(), ctx("conv-2")));
    assert.equal(fake.state.sessions.length, 2);
    assert.equal(fake.state.messages.length, 3);
  } finally {
    close();
  }
});

test("cloudAgents: ephemeral session archived after stream completes", async () => {
  const { provider, fake, close } = await startProvider();
  try {
    await aggregateStream(
      provider.stream(ccRequest(), { requestId: "r1", signal: new AbortController().signal }),
    );
    assert.equal(fake.state.archived.length, 1);
  } finally {
    close();
  }
});

test("cloudAgents: upstream session failure maps to ProviderError with original message", async () => {
  const { provider, close } = await startProvider({ createSessionStatus: 500 });
  try {
    await assert.rejects(
      () =>
        aggregateStream(
          provider.stream(ccRequest(), { requestId: "r1", signal: new AbortController().signal }),
        ),
      (error) =>
        error instanceof ProviderError &&
        error.code === "PROVIDER_UNAVAILABLE" &&
        /Qoder HTTP 500/.test(error.message),
    );
  } finally {
    close();
  }
});

test("cloudAgents: upstream session.error event becomes PROVIDER_PROTOCOL_ERROR", async () => {
  const { provider, close } = await startProvider({ fixture: "error.sse" });
  try {
    await assert.rejects(
      () =>
        aggregateStream(
          provider.stream(ccRequest(), { requestId: "r1", signal: new AbortController().signal }),
        ),
      (error) =>
        error instanceof ProviderError &&
        error.code === "PROVIDER_PROTOCOL_ERROR" &&
        error.message === "agent crashed",
    );
  } finally {
    close();
  }
});

test("cloudAgents: full-text events aggregate exactly once", async () => {
  const { provider, close } = await startProvider({ fixture: "fulltext.sse" });
  try {
    const result = await aggregateStream(
      provider.stream(ccRequest(), { requestId: "r1", signal: new AbortController().signal }),
    );
    assert.equal(result.text, "full text answer");
  } finally {
    close();
  }
});

test("cloudAgents: listModels exposes configured aliases", async () => {
  const { provider, close } = await startProvider();
  try {
    assert.deepEqual(await provider.listModels(), [{ id: "cc", label: "test" }]);
  } finally {
    close();
  }
});

test("cloudAgents: unknown model maps to MODEL_NOT_FOUND", async () => {
  const { provider, close } = await startProvider();
  try {
    await assert.rejects(
      () =>
        aggregateStream(
          provider.stream(
            { model: "nope", messages: [{ role: "user", content: "hi" }] },
            { requestId: "r1", signal: new AbortController().signal },
          ),
        ),
      (error) => error instanceof ProviderError && error.code === "MODEL_NOT_FOUND",
    );
  } finally {
    close();
  }
});

test("cloudAgents: abort mid-stream ends with PROVIDER_ABORTED", async () => {
  const { provider, close } = await startProvider({ holdStream: true });
  try {
    const controller = new AbortController();
    const iterator = provider
      .stream(ccRequest(), { requestId: "r1", signal: controller.signal })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal((first.value as ErrorEvent).type, "message.start");
    controller.abort();
    const step = await iterator.next();
    assert.equal(step.done, false);
    assert.equal((step.value as ErrorEvent).type, "error");
    assert.equal((step.value as ErrorEvent).error.code, "PROVIDER_ABORTED");
  } finally {
    close();
  }
});
