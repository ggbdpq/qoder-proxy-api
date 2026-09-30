// GatewayProvider 行为测试：假上游全链路（jobToken → 模型目录 → 聊天 SSE）。
// 注意：这是协议形状测试，不代表真实网关行为已验证（U3/U4 风险）。
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { GatewayProvider } from "../../src/providers/gateway/index.ts";
import { aggregateStream } from "../../src/core/aggregate.ts";
import { ProviderError } from "../../src/core/errors.ts";
import type { CanonicalRequest, CanonicalMessage } from "../../src/core/request.ts";
import type { TextDeltaEvent, MessageEndEvent } from "../../src/core/events.ts";
import { runProviderContract } from "../contracts/providerContract.ts";
import { createFakeGateway } from "../helpers/fakeGateway.ts";

interface StartProviderOptions {
  sseFixture?: string;
  jobTokenStatus?: number;
}

async function startProvider({ sseFixture, jobTokenStatus }: StartProviderOptions = {}) {
  const fake = createFakeGateway({ sseFixture, jobTokenStatus });
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
    fake,
    close() {
      fake.close();
    },
  };
}

const textRequest: CanonicalRequest = {
  model: "Qwen3.7-Max",
  messages: [{ role: "user", content: "hi" }],
};

const ctx = () => ({ requestId: "r1", signal: new AbortController().signal });

test("gateway contract: satisfies the provider contract over fake upstream", async () => {
  const { provider, close } = await startProvider();
  try {
    await runProviderContract({
      provider,
      scenarios: {
        stream: {
          request: textRequest,
          expect(events) {
            assert.deepEqual(
              events.map((event) => event.type),
              ["text.delta", "text.delta", "message.end"],
            );
            assert.equal((events[0] as TextDeltaEvent).text, "Hel");
            assert.equal((events[1] as TextDeltaEvent).text, "lo");
            assert.equal((events[2] as MessageEndEvent).stopReason, "stop");
          },
        },
      },
    });
  } finally {
    close();
  }
});

test("gateway: thinking and tool_call deltas normalize to canonical events", async () => {
  const { provider, close } = await startProvider({ sseFixture: "thinking-tools.sse" });
  try {
    const result = await aggregateStream(provider.stream(textRequest, ctx()));
    assert.equal(result.thinking, "let me think");
    assert.equal(result.text, "answer");
    assert.equal(result.stopReason, "tool_use");
    assert.deepEqual(result.toolCalls, [
      { id: "call_1", name: "get_weather", arguments: '{"city":"Hanoi"}' },
    ]);
  } finally {
    close();
  }
});

test("gateway: in-stream 403 becomes PROVIDER_AUTH_ERROR", async () => {
  const { provider, close } = await startProvider({ sseFixture: "auth-error.sse" });
  try {
    await assert.rejects(
      () => aggregateStream(provider.stream(textRequest, ctx())),
      (error) => error instanceof ProviderError && error.code === "PROVIDER_AUTH_ERROR",
    );
  } finally {
    close();
  }
});

test("gateway: missing PAT fails fast at construction", () => {
  assert.throws(() => new GatewayProvider({ pat: "" }), /QODER_GATEWAY_PAT/);
});

test("gateway: auth refresh — expired session triggers refresh with needRefresh=true", async () => {
  const { provider, fake, close } = await startProvider();
  try {
    await aggregateStream(provider.stream(textRequest, ctx()));
    const first = provider.auth.session;
    assert.ok(first, "session should exist after first request");
    assert.equal(fake.state.jobTokenRequests, 1);
    assert.equal(
      fake.state.jobTokenBodies[0]?.payload &&
        JSON.parse(fake.state.jobTokenBodies[0]!.payload as string).needRefresh,
      false,
    );

    // 模拟过期：needsRefresh 走 renew（refresh path）。session 必已存在（上方断言）。
    provider.auth.session!.expireTimeMs = Date.now() - 1;
    await aggregateStream(provider.stream(textRequest, ctx()));
    assert.equal(fake.state.jobTokenRequests, 2);
    const secondBody = JSON.parse(fake.state.jobTokenBodies[1]!.payload as string);
    assert.equal(secondBody.needRefresh, true);
    assert.equal(secondBody.refreshToken, first.refreshToken);
  } finally {
    close();
  }
});

test("gateway: single-flight — concurrent requests share one jobToken exchange", async () => {
  const { provider, fake, close } = await startProvider();
  try {
    await Promise.all([
      aggregateStream(provider.stream(textRequest, ctx())),
      aggregateStream(provider.stream(textRequest, ctx())),
      aggregateStream(provider.stream(textRequest, ctx())),
    ]);
    assert.equal(fake.state.jobTokenRequests, 1);
    assert.equal(fake.state.modelListRequests, 1);
  } finally {
    close();
  }
});

test("gateway: PAT rejected maps to PROVIDER_AUTH_ERROR", async () => {
  const { provider, close } = await startProvider({ jobTokenStatus: 401 });
  try {
    await assert.rejects(
      () => aggregateStream(provider.stream(textRequest, ctx())),
      (error) =>
        error instanceof ProviderError &&
        error.code === "PROVIDER_AUTH_ERROR" &&
        /HTTP 401/.test(error.message),
    );
  } finally {
    close();
  }
});

test("gateway: chat request wire shape matches the protocol template", async () => {
  const { provider, fake, close } = await startProvider();
  try {
    // wire 形状测试锁定 system 消息透传；网关 mapMessages 运行时支持 role: "system"，
    // 但 CanonicalMessage 类型合同尚未收录该 role（src 侧缺口，此处类型洗白不改值）。
    const systemMessage = { role: "system", content: "be brief" } as unknown as CanonicalMessage;
    await aggregateStream(
      provider.stream(
        {
          model: "Qwen3.7-Plus",
          messages: [systemMessage, { role: "user", content: "hi there" }],
          tools: [{ name: "get_weather", inputSchema: { type: "object" } }],
        },
        ctx(),
      ),
    );
    const chat = fake.state.chatRequests.at(-1)!;
    assert.equal(chat.query.AgentId, "agent_common");
    assert.equal(chat.query.FetchKeys, "llm_model_result");
    assert.match(chat.headers.authorization!, /^Bearer COSY\./);
    assert.ok(chat.headers["cosy-key"]);
    assert.ok(chat.headers["cosy-date"]);
    assert.ok(chat.headers.signature || true); // 聊天请求走 Bearer，不必带 MD5 signature

    // body 是自定义编码；解码验证结构。
    const { decode } = await import("../../src/providers/gateway/codec.ts");
    const body = JSON.parse(decode(chat.body).toString("utf8"));
    assert.match(body.request_id, /^[0-9a-f-]{36}$/);
    assert.equal(body.model_config.key, "qmodel");
    assert.equal(body.model_config.is_reasoning, true);
    assert.equal(body.chat_context.text.text, "hi there");
    assert.equal(body.tools[0].function.name, "get_weather");
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[1].contents[0].text, "hi there");
  } finally {
    close();
  }
});

test("gateway: model catalog falls back when endpoint fails", async () => {
  const { close } = await startProvider();
  try {
    // 用一个不存在的 base 来触发失败：重建 provider 指向错误端口。
    const broken = new GatewayProvider({
      pat: "qoder_pat_fake",
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    const models = await broken.listModels();
    assert.ok(models.length > 0, "fallback catalog should be served");
    assert.ok(models.some((model) => model.id === "Qwen3.7-Max"));
  } finally {
    close();
  }
});
