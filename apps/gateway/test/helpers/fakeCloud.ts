import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "cloud",
);

export function loadCloudFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf8");
}

// 按 SSE 事件切分 fixture 文本，返回原始事件块数组（含结尾空行）。
function splitSseBlocks(text: string): string[] {
  return text
    .split(/(?<=\n\n)/)
    .map((block) => block)
    .filter((block) => block.trim());
}

// fake 上游记录的可断言状态；body 是任意 JSON 载荷。
export interface FakeCloudState {
  sessions: { id: string; body: unknown }[];
  messages: { sessionId: string; body: unknown }[];
  archived: string[];
  streamRequests: number;
}

export interface FakeCloudServer extends http.Server {
  state: FakeCloudState;
}

interface FakeCloudOptions {
  fixture?: string;
  createSessionStatus?: number;
  holdStream?: boolean;
}

// 最小 Qoder Cloud Agents API 假上游：只实现 qoder-client.js 会用到的端点。
export function createFakeCloud({
  fixture = "deltas.sse",
  createSessionStatus = 200,
  holdStream = false,
}: FakeCloudOptions = {}): FakeCloudServer {
  const blocks = splitSseBlocks(loadCloudFixture(fixture));
  const state: FakeCloudState = {
    sessions: [],
    messages: [],
    archived: [],
    streamRequests: 0,
  };
  let nextId = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake.cloud");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;

    if (req.method === "POST" && url.pathname === "/api/v1/cloud/sessions") {
      if (createSessionStatus !== 200) {
        return json(res, createSessionStatus, { message: "upstream rejected session" });
      }
      const id = `sess_${++nextId}`;
      state.sessions.push({ id, body });
      return json(res, 200, { id });
    }

    const match = url.pathname.match(/^\/api\/v1\/cloud\/sessions\/([^/]+)(\/.*)?$/);
    if (match) {
      const [, sessionId, action] = match;
      if (action === "/events" && req.method === "POST") {
        state.messages.push({ sessionId, body });
        return json(res, 200, { ok: true });
      }
      if (action === "/events" && req.method === "GET") {
        return json(res, 200, { data: [] });
      }
      if (action === "/events/stream" && req.method === "GET") {
        state.streamRequests += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        const blocksToSend = holdStream ? blocks.slice(0, 1) : blocks;
        for (const block of blocksToSend) {
          if (res.destroyed) return;
          res.write(block);
          await delay(1);
        }
        if (holdStream) return; // 保持连接打开，供 abort 场景使用
        res.end();
        return;
      }
      if (action === "/archive" && req.method === "POST") {
        state.archived.push(sessionId);
        return json(res, 200, { ok: true });
      }
    }

    json(res, 404, { message: `unknown path ${req.method} ${url.pathname}` });
  }) as FakeCloudServer;

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
