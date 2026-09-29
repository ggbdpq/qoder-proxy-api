// 下游 SSE 写出工具（进站方向；上游 SSE 解析在 src/sse.js 与各 Provider 内）。
export function beginSse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

export function writeSseData(res, data) {
  if (res.destroyed) return;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function writeSseDone(res) {
  if (res.destroyed) return;
  res.write("data: [DONE]\n\n");
}

export function writeAnthropicSse(res, event, data) {
  if (res.destroyed) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function unixNow() {
  return Math.floor(Date.now() / 1000);
}
