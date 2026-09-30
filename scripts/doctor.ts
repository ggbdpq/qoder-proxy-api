#!/usr/bin/env node
// 三条 Provider 链路的配置体检（只读，不打印任何 secret）。
// 用法：npm run doctor
import { existsSync } from "node:fs";
import process from "node:process";
import { spawnSync } from "node:child_process";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

const mark = (ok: boolean): string => (ok ? "OK " : "MISSING");

console.log("qoder-proxy-api 配置体检（npm start 默认 gateway 链路）\n");

// gateway：只需要 PAT
const pat = process.env.QODER_GATEWAY_PAT;
console.log(
  `[${mark(Boolean(pat))}] gateway       QODER_GATEWAY_PAT ${pat ? `（${pat.length} 字符）` : "—— 去 https://qoder.cn/account/integrations 创建 Personal Access Token 后填入 .env"}`,
);

// cli：检查可执行文件
const bin = process.env.QODER_CLI_BIN || "qodercli";
const nodePath = process.env.QODER_CLI_NODE;
let cliOk = false;
let cliDetail = "";
if (nodePath || bin.endsWith(".mjs") || bin.endsWith(".ts")) {
  const probe = spawnSync(nodePath || process.execPath, [bin, "--version"], { encoding: "utf8" });
  cliOk = probe.status === 0;
  cliDetail = cliOk
    ? `（${(probe.stdout || "").trim().slice(0, 40)}）`
    : `（执行失败：${(probe.stderr || "").trim().slice(0, 80)}）`;
} else {
  const probe = spawnSync(bin, ["--version"], { encoding: "utf8", shell: false });
  cliOk = probe.status === 0;
  cliDetail = cliOk
    ? `（${(probe.stdout || "").trim().slice(0, 40)}）`
    : process.platform === "win32" && /\.cmd$/i.test(bin)
      ? "（Windows .cmd shim 无法无 shell 启动：把 QODER_CLI_BIN 指向包内真实 cli.js 入口并设 QODER_CLI_NODE=node）"
      : "（未找到或不可执行：确认已安装并 qodercli login，或设置 QODER_CLI_BIN）";
}
console.log(`[${mark(cliOk)}] cli           ${bin} ${cliDetail}`);

// cloudAgents：三元组
const triple = [
  process.env.QODER_ACCESS_TOKEN,
  process.env.QODER_AGENT_ID,
  process.env.QODER_ENVIRONMENT_ID,
];
console.log(
  `[${mark(triple.every(Boolean))}] cloudAgents   三元组（ACCESS_TOKEN / AGENT_ID / ENVIRONMENT_ID）${triple.every(Boolean) ? "齐全" : "—— 不全；可用 npm run setup:cloudAgents 自动获取"}`,
);

console.log(
  `\n监听：${process.env.HOST || "127.0.0.1"}:${process.env.PORT || "8320"}  下游鉴权：PROXY_API_KEY ${process.env.PROXY_API_KEY ? "已设置" : "未设置（下游免鉴权，仅本机使用）"}`,
);
