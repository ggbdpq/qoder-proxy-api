// Gateway 聊天请求模板（来源：公开协议参考模板，逆向自官方客户端）。
// 运行时覆盖 6 个动态字段：request_id / chat_record_id / request_set_id /
// session_id / business.id / business.begin_at（参考实现注释明确占位符不做预替换）。
import type { CanonicalRequest } from "../../core/request.ts";

export interface GatewayResponseMeta {
  id: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details: { reasoning_tokens: number };
    prompt_tokens_details: { cached_tokens: number };
  };
}

// Gateway wire 消息（参考实现的请求形状）：user 用 contents parts，assistant/tool 用结构化 content。
export interface GatewayWireMessage {
  role: string;
  content?: string;
  contents?: GatewayContentPart[];
  response_meta?: GatewayResponseMeta;
  reasoning_content_signature?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: GatewayWireToolCall[];
}

export type GatewayContentPart =
  | { type: "image_url"; image_url: { url: string } }
  | { type: "text"; text: string };

export interface GatewayWireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface GatewayWireTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface GatewayChatTemplate {
  request_id: string;
  request_set_id: string;
  chat_record_id: string;
  stream: boolean;
  chat_task: string;
  chat_context: {
    extra: {
      modelConfig: { is_reasoning: boolean; key: string; is_vl?: boolean };
      originalContent: { type: string; text: string };
    };
    text: { type: string; text: string };
  };
  session_id: string;
  source: number;
  version: string;
  aliyun_user_type: string;
  session_type: string;
  agent_id: string;
  task_id: string;
  model_config: { key: string; is_vl: boolean; is_reasoning: boolean; source: string };
  messages: GatewayWireMessage[];
  tools?: GatewayWireTool[];
  tool_choice?: CanonicalRequest["toolChoice"];
  business: { id: string; name: string; begin_at: number };
}

export function newChatTemplate(): GatewayChatTemplate {
  return {
    request_id: "",
    request_set_id: "",
    chat_record_id: "",
    stream: true,
    chat_task: "FREE_INPUT",
    chat_context: {
      extra: {
        modelConfig: { is_reasoning: false, key: "lite" },
        originalContent: { type: "text", text: "" },
      },
      text: { type: "text", text: "" },
    },
    session_id: "",
    source: 1,
    version: "3",
    aliyun_user_type: "personal_standard",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    model_config: { key: "lite", is_vl: false, is_reasoning: false, source: "system" },
    messages: [],
    business: { id: "", name: "", begin_at: 0 },
  };
}
