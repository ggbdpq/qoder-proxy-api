// Canonical Request 与 ProviderContext：下游协议 → Provider 的统一请求语言。
// workspace / session / cwd / request id 等运行上下文一律走 ProviderContext，
// 不允许污染消息正文，也不允许 Provider 私有概念泄漏进协议层。

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  source: Record<string, unknown>;
}

export type CanonicalContentPart = TextPart | ImagePart;

export interface CanonicalToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface CanonicalMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | CanonicalContentPart[];
  toolCallId?: string;
  toolCalls?: CanonicalToolCall[];
}

export interface CanonicalTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface CanonicalRequest {
  model: string;
  system?: string | CanonicalContentPart[];
  messages: CanonicalMessage[];
  tools?: CanonicalTool[];
  toolChoice?: "auto" | "none" | { name: string };
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high" | "max";
  metadata?: Record<string, unknown>;
}

export interface ProviderContext {
  requestId: string;
  conversationId?: string;
  cwd?: string;
  signal: AbortSignal;
}

export function createProviderContext({
  requestId,
  conversationId,
  cwd,
  signal,
}: Partial<ProviderContext> = {}): ProviderContext {
  return {
    requestId:
      requestId || `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    conversationId,
    cwd,
    signal: signal ?? new AbortController().signal,
  };
}
