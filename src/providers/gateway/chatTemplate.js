// Gateway 聊天请求模板（来源：公开协议参考模板，逆向自官方客户端）。
// 运行时覆盖 6 个动态字段：request_id / chat_record_id / request_set_id /
// session_id / business.id / business.begin_at（参考实现注释明确占位符不做预替换）。
export function newChatTemplate() {
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
