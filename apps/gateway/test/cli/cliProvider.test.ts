import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CliProvider } from "../../src/providers/cli/index.ts";
import { createStreamJsonParser, messagesToPrompt } from "../../src/providers/cli/streamParser.ts";
import { aggregateStream } from "../../src/core/aggregate.ts";
import { ProviderError } from "../../src/core/errors.ts";
import type { CanonicalRequest } from "../../src/core/request.ts";
import { runProviderContract } from "../contracts/providerContract.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

// fake CLI：node 脚本按 prompt 内容驱动行为（hang / exit3 / 正常 fixture 流），
// 完全不依赖真实 qodercli。行为约定见 test/helpers/fakeCli.ts。
function cliProvider({ timeoutMs = 10000 }: { timeoutMs?: number } = {}) {
  return new CliProvider({
    cliConfig: {
      nodePath: process.execPath,
      bin: path.join(here, "..", "helpers", "fakeCli.ts"),
      model: "",
      workspace: "",
      timeoutMs,
    },
  });
}

const ctx = () => ({
  requestId: "r1",
  signal: new AbortController().signal,
  cwd: undefined,
});

const request = (content: string): CanonicalRequest => ({
  model: "auto",
  messages: [{ role: "user", content }],
});

test("cli streamParser: assistant parts and result.done normalize", () => {
  const parser = createStreamJsonParser();
  const lines = [
    '{"type":"system","subtype":"init"}',
    '{"type":"assistant","message":{"content":[{"type":"reasoning","thinking":"hmm"}]}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}',
    "not-json garbage",
    '{"type":"result","done":true}',
  ];
  const events = lines.flatMap((line) => parser.parseLine(line));
  assert.deepEqual(events, [
    { type: "thinking.delta", text: "hmm" },
    { type: "text.delta", text: "Hello" },
    { type: "message.end", stopReason: "stop" },
  ]);
});

test("cli prompt: full conversation rendered with roles", () => {
  const prompt = messagesToPrompt({
    model: "auto",
    system: "be brief",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "bye" },
    ],
  });
  assert.equal(prompt, "System: be brief\n\nUser: hi\n\nAssistant: hello\n\nUser: bye");
});

test("cli provider: contract satisfied via fake cli process", async () => {
  const provider = cliProvider();
  const hangContext = { requestId: "r-abort", signal: new AbortController().signal };
  await runProviderContract({
    provider,
    scenarios: {
      stream: {
        request: request("hi"),
        context: ctx(),
        expect(events) {
          assert.deepEqual(
            events.map((event) => event.type),
            ["thinking.delta", "text.delta", "text.delta", "message.end"],
          );
        },
      },
      abort: {
        request: request("hang"),
        context: hangContext,
      },
      unsupported: {
        request: { ...request("hi"), tools: [{ name: "t", inputSchema: {} }] },
      },
    },
  });
});

test("cli provider: aggregation matches fixture content", async () => {
  const provider = cliProvider();
  const result = await aggregateStream(provider.stream(request("hi"), ctx()));
  assert.equal(result.thinking, "need a greeting");
  assert.equal(result.text, "Hello, CLI");
  assert.equal(result.stopReason, "stop");
});

test("cli provider: nonzero exit maps to PROVIDER_UNAVAILABLE with stderr tail", async () => {
  const provider = cliProvider();
  await assert.rejects(
    () => aggregateStream(provider.stream(request("exit3"), ctx())),
    (error) =>
      error instanceof ProviderError &&
      error.code === "PROVIDER_UNAVAILABLE" &&
      /code 3/.test(error.message) &&
      /simulated cli failure/.test(error.message),
  );
});

test("cli provider: timeout kills the process and maps to PROVIDER_TIMEOUT", async () => {
  const provider = cliProvider({ timeoutMs: 300 });
  await assert.rejects(
    () => aggregateStream(provider.stream(request("hang"), ctx())),
    (error) => error instanceof ProviderError && error.code === "PROVIDER_TIMEOUT",
  );
});

test("cli provider: client abort terminates the process", async () => {
  const provider = cliProvider();
  const controller = new AbortController();
  const iterator = provider
    .stream(request("hang"), { requestId: "r", signal: controller.signal })
    [Symbol.asyncIterator]();
  controller.abort();
  const step = await iterator.next();
  assert.equal(step.done, false);
  assert.equal(step.value.type, "error");
  assert.equal(step.value.error.code, "PROVIDER_ABORTED");
});

test("cli provider: missing binary maps to PROVIDER_UNAVAILABLE", async () => {
  const provider = new CliProvider({
    // 缺失二进制的负向用例：nodePath 置空与 loadCliConfig 默认一致（直启 bin）。
    cliConfig: {
      bin: "definitely-not-exists-cli",
      nodePath: "",
      model: "",
      workspace: "",
      timeoutMs: 5000,
    },
  });
  await assert.rejects(
    () => aggregateStream(provider.stream(request("hi"), ctx())),
    (error) =>
      error instanceof ProviderError &&
      error.code === "PROVIDER_UNAVAILABLE" &&
      /not found/.test(error.message),
  );
});
