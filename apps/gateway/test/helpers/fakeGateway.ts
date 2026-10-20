import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decode } from "../../src/providers/gateway/codec.ts";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "gateway",
);

function loadFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf8");
}

// fake 上游记录的可断言状态：请求计数、签名 headers、可逆向的 body。
export interface FakeGatewayState {
  jobTokenRequests: number;
  modelListRequests: number;
  chatRequests: {
    headers: http.IncomingHttpHeaders;
    body: string;
    query: Record<string, string>;
  }[];
  lastAuthHeaders: http.IncomingHttpHeaders | null;
  jobTokenBodies: (Record<string, unknown> | null)[];
}

export interface FakeGatewayServer extends http.Server {
  state: FakeGatewayState;
}

interface FakeGatewayOptions {
  sseFixture?: string;
  jobTokenStatus?: number;
}

// 最小 Qoder Gateway 假上游：jobToken 交换、模型目录、聊天 SSE。
// 记录原始请求供断言（签名 headers、加密 body 形状）。
export function createFakeGateway({
  sseFixture = "text.sse",
  jobTokenStatus = 200,
}: FakeGatewayOptions = {}): FakeGatewayServer {
  const state: FakeGatewayState = {
    jobTokenRequests: 0,
    modelListRequests: 0,
    chatRequests: [],
    lastAuthHeaders: null,
    jobTokenBodies: [],
  };
  let exchangeCount = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake.gateway");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");

    if (url.pathname === "/algo/api/v3/user/jobToken") {
      state.jobTokenRequests += 1;
      state.lastAuthHeaders = req.headers;
      if (jobTokenStatus !== 200) {
        return json(res, jobTokenStatus, { message: "bad pat" });
      }
      // 解开外层编码，验证网关协议里的 body 确实可逆向（.encode 一致性）。
      try {
        const outer = JSON.parse(decode(rawBody).toString("utf8"));
        state.jobTokenBodies.push(outer);
      } catch {
        state.jobTokenBodies.push(null);
      }
      exchangeCount += 1;
      return json(res, 200, {
        name: "fake-user",
        id: `uid_${exchangeCount}`,
        userType: "personal_standard",
        securityOauthToken: `sot_${exchangeCount}`,
        refreshToken: `rt_${exchangeCount}`,
        expireTime: Date.now() + 24 * 60 * 60 * 1000,
      });
    }

    if (url.pathname === "/algo/api/v2/model/list") {
      state.modelListRequests += 1;
      // 2026-09-29 真实目录快照（截取测试相关子集 + Auto 默认项）。
      return json(res, 200, {
        chat: [
          { key: "auto", display_name: "Auto", enable: true, is_vl: true, is_default: true },
          { key: "qmodel_38max", display_name: "Qwen3.8-Max", enable: true, is_vl: true },
          { key: "qmodel_latest", display_name: "Qwen3.7-Max", enable: true, is_vl: true },
          { key: "qmodel", display_name: "Qwen3.7-Plus", enable: true, is_vl: true },
          { key: "q37fmodel", display_name: "Qwen3.7-Flash", enable: true, is_vl: true },
          { key: "gmodel", display_name: "GLM-5.3", enable: true, is_vl: true },
          { key: "mmodel", display_name: "MiniMax-M2.7", enable: true, is_vl: false },
        ],
      });
    }

    if (url.pathname === "/algo/api/v2/service/pro/sse/agent_chat_generation") {
      state.chatRequests.push({
        headers: req.headers,
        body: rawBody,
        query: Object.fromEntries(url.searchParams.entries()),
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const line of loadFixture(sseFixture).split("\n")) {
        if (!line.trim()) continue;
        res.write(`${line}\n`);
        await delay(1);
      }
      res.end();
      return;
    }

    json(res, 404, { message: `unknown path ${req.method} ${url.pathname}` });
  }) as FakeGatewayServer;

  server.state = state;
  return server;
}

export function json(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
