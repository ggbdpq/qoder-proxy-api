// CLI Provider 配置解析。
export interface CliConfig {
  bin: string;
  nodePath: string;
  model: string;
  workspace: string;
  timeoutMs: number;
}

export function loadCliConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  return {
    bin: env.QODER_CLI_BIN || "qodercli",
    // bin 为 .js/.mjs 入口时（Windows npm shim 无法无 shell 启动），指定 node 解释器。
    nodePath: env.QODER_CLI_NODE || "",
    model: env.QODER_CLI_MODEL || "",
    workspace: env.QODER_CLI_WORKSPACE || "",
    timeoutMs: parsePositive(env.QODER_CLI_TIMEOUT_MS, 600000),
    // 额度与账号完全走 qodercli 自身登录态，代理不复制凭证。
  };
}

function parsePositive(value: string | undefined, defaultValue: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}
