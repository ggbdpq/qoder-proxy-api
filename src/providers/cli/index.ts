// CliProvider：本地 qodercli 子进程的出站适配器。
// 认证复用 qodercli 自身登录态（qodercli login），代理不复制 OAuth 凭证。
// 工具策略：v0.3 首发只支持 client tool loop；本 Provider v1 不声明 tools 能力，
// 带 tools 的请求显式 UNSUPPORTED_CAPABILITY，不在代理自身目录跑 Agent Loop。
import { ERROR_CODES, ProviderError } from "../../core/errors.ts";
import { assertCapability } from "../../core/capabilities.ts";
import type { ProviderCapabilities } from "../../core/capabilities.ts";
import type { CanonicalRequest, ProviderContext } from "../../core/request.ts";
import type { ProviderEvent } from "../../core/events.ts";
import type { ProviderModel } from "../../core/provider.ts";
import { loadCliConfig } from "./config.ts";
import type { CliConfig } from "./config.ts";
import { createStreamJsonParser, messagesToPrompt } from "./streamParser.ts";
import { parseJsonlOutput, runCliProcess } from "./process.ts";

export class CliProvider {
  id = "cli";

  config: CliConfig;
  // 模型别名 → CLI model level（如 ultimate）；未配置时原样传递。
  modelAliases: Record<string, string>;

  constructor({
    cliConfig,
    modelAliases,
  }: {
    cliConfig?: CliConfig;
    modelAliases?: Record<string, string>;
  } = {}) {
    this.config = cliConfig || loadCliConfig();
    this.modelAliases = modelAliases || {};
  }

  capabilities(): ProviderCapabilities {
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

  async listModels(): Promise<ProviderModel[]> {
    // CLI 的 model level 集合随版本变化；保守暴露 alias 名单。
    return [
      { id: "auto", label: "CLI default routing" },
      { id: "ultimate", label: "CLI ultimate" },
    ];
  }

  async *stream(
    request: CanonicalRequest,
    context: ProviderContext,
  ): AsyncGenerator<ProviderEvent> {
    assertCapability(this.capabilities(), request);

    const prompt = messagesToPrompt(request);
    if (!prompt.trim()) {
      yield {
        type: "error",
        error: new ProviderError(ERROR_CODES.UNSUPPORTED_CAPABILITY, "request has no text content"),
      };
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

function toProviderError(error: unknown, signal: AbortSignal | undefined): ProviderError {
  if (error instanceof ProviderError) return error;
  if (signal?.aborted || errorField(error, "name") === "AbortError") {
    return new ProviderError(ERROR_CODES.PROVIDER_ABORTED, "cli request aborted");
  }
  return new ProviderError(ERROR_CODES.PROVIDER_UNAVAILABLE, errorText(error), {
    cause: error,
  });
}

// 等价于原 `error?.message || String(error)`（v0.1 动态取值；message 字段实践为 string）。
function errorText(error: unknown): string {
  return (errorField(error, "message") || String(error)) as string;
}

// 宽松 JSON 记录：动态取值的统一读取形状（值保持 unknown，消费处自行窄化）。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// unknown error 的诊断字段读取：非对象时与原可选链一样得到 undefined。
function errorField(error: unknown, field: string): unknown {
  return isRecord(error) ? error[field] : undefined;
}
