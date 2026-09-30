// 下游 SSE 写出工具（进站方向；上游 SSE 解析在 src/sse.js 与各 Provider 内）。
import type { ServerResponse } from "node:http";

export function beginSse(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

export function writeSseData(res: ServerResponse, data: unknown): void {
  if (res.destroyed) return;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function writeSseDone(res: ServerResponse): void {
  if (res.destroyed) return;
  res.write("data: [DONE]\n\n");
}

export function writeAnthropicSse(res: ServerResponse, event: string, data: unknown): void {
  if (res.destroyed) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}
