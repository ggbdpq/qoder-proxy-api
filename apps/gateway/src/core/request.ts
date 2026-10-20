// Canonical Request 与 ProviderContext：下游协议 → Provider 的统一请求语言。
// workspace / session / cwd / request id 等运行上下文一律走 ProviderContext，
// 不允许污染消息正文，也不允许 Provider 私有概念泄漏进协议层。

export interface TextPart {
  type: "text";
  text: string;
  providerExtras?: Record<string, unknown>;
}

export interface ImagePart {
  type: "image";
  mediaType?: string;
  url?: string;
  data?: string;
  source?: Record<string, unknown>;
  providerExtras?: Record<string, unknown>;
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  arguments: string;
  providerExtras?: Record<string, unknown>;
}

export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError?: boolean;
  providerExtras?: Record<string, unknown>;
}

export interface ThinkingPart {
  type: "thinking";
  text: string;
  signature?: string;
  providerExtras?: Record<string, unknown>;
}

export type CanonicalContentPart =
  | TextPart
  | ImagePart
  | ToolCallPart
  | ToolResultPart
  | ThinkingPart;

// 只读文本的 provider 用它取正文。纯文本消息的 content 仍是字符串，结果与直接读 content 相同。
export function textOf(message: { content: string | CanonicalContentPart[] }): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

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
