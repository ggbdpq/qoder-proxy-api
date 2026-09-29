// qodercli 子进程管理：spawn（不经 shell）、JSONL 解析、abort/timeout/退出码。
// 安全边界：prompt 经 argv 传递且不使用 shell，参数不含可注入面；
// Windows npm shim（.cmd）无 shell 无法启动 → fail fast 并给出配置指引。
import { spawn } from "node:child_process";
import { ERROR_CODES, ProviderError } from "../../core/errors.js";

const STDERR_LIMIT = 64 * 1024;
const KILL_ESCALATION_MS = 2000;

export function runCliProcess({ bin, args, nodePath, signal, timeoutMs, cwd }) {
  return new Promise((resolve, reject) => {
    let child;
    const cmd = nodePath ? [bin, ...args] : args;
    try {
      child = spawn(nodePath || bin, cmd, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false, // 禁止 shell 拼接：prompt 含任意文本
        cwd: cwd || undefined,
        windowsHide: true,
      });
    } catch (error) {
      reject(spawnError(error, nodePath ? `${nodePath} ${bin}` : bin));
      return;
    }
    child.on("error", (error) => reject(spawnError(error, nodePath ? `${nodePath} ${bin}` : bin)));

    child.stdin.end();

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const onAbort = () => killTree(child);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      // 上限防内存膨胀；只作诊断，不进模型正文。
      if (stderr.length < STDERR_LIMIT) stderr += chunk;
      if (stderr.length >= STDERR_LIMIT) stderr = `${stderr.slice(0, STDERR_LIMIT)}\n[truncated]`;
    });

    child.on("close", (code, killed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(new ProviderError(ERROR_CODES.PROVIDER_ABORTED, "cli request aborted"));
        return;
      }
      if (timedOut) {
        reject(
          new ProviderError(ERROR_CODES.PROVIDER_TIMEOUT, `cli timeout after ${timeoutMs}ms`, {
            cause: stderrSnippet(stderr),
          }),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new ProviderError(
            ERROR_CODES.PROVIDER_UNAVAILABLE,
            `cli exited with code ${code}: ${stderrSnippet(stderr)}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// 全量 JSONL → Canonical Events（非流式聚合路径直接消费完整输出）。
export function parseJsonlOutput(stdout, parseLine) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    events.push(...parseLine(line));
  }
  return events;
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, KILL_ESCALATION_MS).unref?.();
}

function stderrSnippet(stderr) {
  const text = String(stderr || "").trim();
  if (!text) return "no stderr";
  return text.slice(-300);
}

function spawnError(error, bin) {
  // Node ≥18.20 对 .cmd/.bat 无 shell spawn 抛 EINVAL（CVE-2024-27980 防御）。
  if (error?.code === "EINVAL" && process.platform === "win32") {
    return new ProviderError(
      ERROR_CODES.PROVIDER_UNAVAILABLE,
      `cannot spawn "${bin}" directly on Windows (npm .cmd shim requires a shell, which this proxy forbids); ` +
        'set QODER_CLI_BIN to the real node entry, e.g. "node " + the cli.js inside the qoder package',
      { cause: error },
    );
  }
  if (error?.code === "ENOENT") {
    return new ProviderError(
      ERROR_CODES.PROVIDER_UNAVAILABLE,
      `cli binary not found: "${bin}" (set QODER_CLI_BIN)`,
      { cause: error },
    );
  }
  return new ProviderError(ERROR_CODES.PROVIDER_UNAVAILABLE, error?.message || String(error), {
    cause: error,
  });
}
