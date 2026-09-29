// 进站侧共享 HTTP 工具。
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

export async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError(413, "request body too large");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new HttpError(400, "invalid JSON body", { cause: error.message });
  }
}

export function writeJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export function writeOpenAIError(
  res,
  status,
  message,
  type = "invalid_request_error",
  details = undefined,
) {
  writeJson(res, status, {
    error: {
      message,
      type,
      param: null,
      code: null,
      details,
    },
  });
}

export function requireBearer(req, expectedKey) {
  if (!expectedKey) return;
  const auth = req.headers.authorization || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (token !== expectedKey) {
    throw new HttpError(401, "invalid or missing bearer token");
  }
}

export function parseUrl(req) {
  return new URL(req.url || "/", "http://127.0.0.1");
}

export function setCors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type,x-qoder-session-id");
}

// 各协议 wire id 的统一生成规则：前缀 + base36 时间 + 随机尾巴（v0.1 语义）。
export function wireId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
