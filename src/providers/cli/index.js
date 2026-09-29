// CliProvider：本地 qodercli 子进程的出站适配器。
// 认证复用 qodercli 自身登录态（qodercli login），代理不复制 OAuth 凭证。
// 工具策略：v0.3 首发只支持 client tool loop；本 Provider v1 不声明 tools 能力，
// 带 tools 的请求显式 UNSUPPORTED_CAPABILITY，不在代理自身目录跑 Agent Loop。
import { ERROR_CODES, ProviderError } from "../../core/errors.js";
import { assertCapability } from "../../core/capabilities.js";
import { loadCliConfig } from "./config.js";
import { createStreamJsonParser, messagesToPrompt } from "./streamParser.js";
import { parseJsonlOutput, runCliProcess } from "./process.js";

export class CliProvider {
  id = "cli";

  constructor({ cliConfig, modelAliases } = {}) {
    this.config = cliConfig || loadCliConfig();
    // 模型别名 → CLI model level（如 ultimate）；未配置时原样传递。
    this.modelAliases = modelAliases || {};
  }

  capabilities() {
    return {
      streaming: true,
      cancellation: true,
      sessions: "none", // v1 每请求独立进程；会话重放由请求消息承载
      tools: "none",
      thinking: "text", // reasoning part 以 thinking 事件透出
      vision: "none",
      modelDiscovery: "static",
      usage: "none",
      resume: "none",
    };
  }

  async listModels() {
    // CLI 的 model level 集合随版本变化；保守暴露 alias 名单。
    return [
      { id: "auto", label: "CLI default routing" },
      { id: "ultimate", label: "CLI ultimate" },
    ];
  }

  async *stream(request, context) {
    assertCapability(this.capabilities(), request);

    const prompt = messagesToPrompt(request);
    if (!prompt.trim()) {
      yield { type: "error", error: new ProviderError(ERROR_CODES.UNSUPPORTED_CAPABILITY, "request has no text content") };
      return;
    }

    const args = ["-p", prompt, "-q", "-f", "stream-json"];
    const requested = !request.model || request.model === "default" ? "auto" : request.model;
    const model = this.modelAliases[requested] || requested;
    if (model && model !== "auto") args.push("--model", model);
    if (context.cwd) args.push("-w", context.cwd);

    const parser = createStreamJsonParser();
    try {
      const { stdout } = await runCliProcess({
        bin: this.config.bin,
        args,
        nodePath: this.config.nodePath, // bin 为 .js/.mjs 入口时提供 node 解释器
        signal: context.signal,
        timeoutMs: this.config.timeoutMs,
        cwd: context.cwd,
      });
      let sawEnd = false;
      for (const event of parseJsonlOutput(stdout, (line) => parser.parseLine(line))) {
        if (event.type === "message.end") sawEnd = true;
        yield event;
      }
      if (!sawEnd) yield { type: "message.end", stopReason: "stop" };
    } catch (error) {
      yield { type: "error", error: toProviderError(error, context.signal) };
    }
  }
}

function toProviderError(error, signal) {
  if (error instanceof ProviderError) return error;
  if (signal?.aborted || error?.name === "AbortError") {
    return new ProviderError(ERROR_CODES.PROVIDER_ABORTED, "cli request aborted");
  }
  return new ProviderError(ERROR_CODES.PROVIDER_UNAVAILABLE, error?.message || String(error), {
    cause: error,
  });
}
