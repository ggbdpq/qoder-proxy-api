#!/usr/bin/env node
// Gateway 真实端到端冒烟（live-gated）。
// 运行条件：QODER_LIVE_GATEWAY=1 且 QODER_GATEWAY_PAT 已配置；否则提示后退出。
// 输出全程脱敏（不打印 PAT / Bearer / cosy-key / refreshToken）。
// 失败时把原始 SSE 行写入 test/fixtures/gateway/live/，供校准 fixtures。
import process from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

// 与 src/index.js 一致：自动加载 .env（键已存在于环境时不覆盖）。
if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}
import { GatewayAuth, gatewayEndpoints } from "../../src/providers/gateway/auth.ts";
import { GatewayClient } from "../../src/providers/gateway/client.ts";
import { extractCatalog, resolveModelKey } from "../../src/providers/gateway/models.ts";
import type { GatewayModel } from "../../src/providers/gateway/models.ts";
import { extractEnvelopeDelta, parseEnvelope } from "../../src/providers/gateway/normalize.ts";
import { buildChatRequestBody } from "../../src/providers/gateway/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function gate() {
  if (process.env.QODER_LIVE_GATEWAY !== "1") {
    console.log("[skip] 设置 QODER_LIVE_GATEWAY=1 才会运行真实网关冒烟");
    process.exit(0);
  }
  if (!process.env.QODER_GATEWAY_PAT) {
    console.log("[skip] 缺少 QODER_GATEWAY_PAT（写入 .env 即可，已被 gitignore）");
    process.exit(0);
  }
}

function redact(text: unknown): string {
  return String(text)
    .replaceAll(process.env.QODER_GATEWAY_PAT ?? "\u0000", "<PAT>")
    .replaceAll(/Bearer[^\s",]+/g, "Bearer<redacted>")
    .replaceAll(/COSY\.[^"']+/g, "COSY.<redacted>");
}

async function main() {
  gate();
  const auth = new GatewayAuth({ pat: process.env.QODER_GATEWAY_PAT });
  const endpoints = gatewayEndpoints();
  const client = new GatewayClient({ auth, endpoints, requestTimeoutMs: 60000 });

  // 1) jobToken 交换
  console.log("== step 1: jobToken exchange ==");
  try {
    const session = await auth.ensureSession();
    console.log(
      `ok: user=${redact(session.identity.name) || "(empty)"} userType=${session.identity.userType} expireIn=${Math.round((session.expireTimeMs - Date.now()) / 60000)}min`,
    );
  } catch (error) {
    console.log(`FAIL: ${redact((error as Error).message)}`);
    process.exit(1);
  }

  // 2) 模型目录
  console.log("== step 2: model catalog ==");
  let catalog: GatewayModel[] | undefined = undefined;
  try {
    const raw = await client.getJson(endpoints.modelList);
    catalog = extractCatalog(raw);
    console.log(`ok: ${catalog.length} models`);
    for (const model of catalog) {
      console.log(
        `  - ${model.displayName} (key=${model.key}${model.isDefault ? ", default" : ""}${model.vision ? ", vl" : ""})`,
      );
    }
    if (!catalog.length) console.log("WARN: empty catalog; falling back to builtin list");
  } catch (error) {
    console.log(`FAIL: ${redact((error as Error).message)}\n（目录拉取失败不阻断，继续用兜底表）`);
  }
  const model = resolveModelKey(
    catalog?.length ? catalog : extractCatalog({}),
    process.argv[2] || "default",
  );
  if (!model) {
    console.log("FAIL: no usable model in catalog");
    process.exit(1);
  }
  console.log(`using model: ${model.displayName} (key=${model.key})`);

  // 3) 最小对话流（复用生产请求构建器，messages 由它负责填充）
  console.log("== step 3: chat stream ==");
  const body = buildChatRequestBody(
    { model: model.displayName, messages: [{ role: "user", content: "只回复 OK" }] },
    model,
  );

  const started = Date.now();
  const rawLines = [];
  const eventTypes = [];
  let text = "";
  let thinking = "";
  let firstTokenMs = -1;
  let failure = null;

  try {
    for await (const line of client.streamEvents(endpoints.chatSse, body, {
      signal: new AbortController().signal,
    })) {
      rawLines.push(line);
      const parsed = parseEnvelope(line);
      if (!parsed) {
        eventTypes.push("(unparsed)");
        continue;
      }
      if (parsed.authError) {
        failure = `auth error in stream: ${redact(parsed.authError.message)}`;
        break;
      }
      if (parsed.error) {
        failure = `protocol error: ${redact(parsed.error.message)}`;
        break;
      }
      const delta = extractEnvelopeDelta(parsed.body);
      if (delta.thinking || delta.text || delta.toolCalls.length) {
        if (firstTokenMs < 0) firstTokenMs = Date.now() - started;
      }
      if (delta.thinking) {
        thinking += delta.thinking;
        eventTypes.push("thinking.delta");
      }
      if (delta.text) {
        text += delta.text;
        eventTypes.push("text.delta");
      }
      if (delta.toolCalls.length) eventTypes.push("tool_calls");
    }
  } catch (error) {
    failure = redact((error as Error).message);
  }

  console.log(
    `events: ${eventTypes.slice(0, 20).join(" ")}${eventTypes.length > 20 ? ` …(+${eventTypes.length - 20})` : ""}`,
  );
  console.log(
    `firstTokenMs=${firstTokenMs} totalMs=${Date.now() - started} textLen=${text.length} thinkingLen=${thinking.length}`,
  );
  console.log(`text: ${JSON.stringify(text.slice(0, 200))}`);
  if (thinking) console.log(`thinking: ${JSON.stringify(thinking.slice(0, 120))}`);

  if (failure || !text) {
    console.log(`\nRESULT: FAIL — ${failure || "stream ended without text"}`);
    if (rawLines.length) {
      const dir = path.join(here, "..", "fixtures", "gateway", "live");
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `failure-${Date.now()}.sse`);
      writeFileSync(file, rawLines.map(redact).join("\n") + "\n", "utf8");
      console.log(
        `原始响应已脱敏落盘：${path.relative(process.cwd(), file)}（校准 fixtures 用；确认无敏感信息后再决定是否提交）`,
      );
    }
    process.exit(1);
  }
  console.log("\nRESULT: PASS");
}

main();
