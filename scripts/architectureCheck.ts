#!/usr/bin/env node
// 架构消融检查：目录依赖方向硬约束（一次性脚本，不入 npm scripts）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (full.endsWith(".ts")) files.push(full);
  }
  return files;
}

function zoneOf(absPath: string): string {
  const norm = path.relative(root, absPath).split(path.sep).join("/");
  if (norm.startsWith("core")) return "core";
  if (norm.startsWith("protocols")) return "protocols";
  if (norm.startsWith("providers")) return "providers";
  if (norm.startsWith("routing")) return "routing";
  if (norm.startsWith("server")) return "server";
  return "root";
}

const violations = [];
for (const file of walk(root)) {
  const from = zoneOf(file);
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    const target = path.resolve(path.dirname(file), m[1]);
    const to = zoneOf(target);
    if (from === "protocols" && to === "providers")
      violations.push(`[protocols→providers] ${path.relative(root, file)} -> ${m[1]}`);
    if (from === "providers" && to === "protocols")
      violations.push(`[providers→protocols] ${path.relative(root, file)} -> ${m[1]}`);
    if (from === "core" && ["providers", "protocols", "routing", "server"].includes(to))
      violations.push(`[core→${to}] ${path.relative(root, file)} -> ${m[1]}`);
    if (from === "routing" && ["providers", "protocols"].includes(to))
      violations.push(`[routing→${to}] ${path.relative(root, file)} -> ${m[1]}`);
  }
}

console.log(violations.length ? violations.join("\n") : "ALL DEPENDENCY RULES PASS");

// server 层协议细节泄漏检查
const leaks = [];
for (const rel of ["server/server.ts", "server/http.ts", "server/sse.ts"]) {
  const text = readFileSync(path.join(root, rel), "utf8");
  // session_id/qoder_session_id 是下游请求的会话 key 字段（客户端 API 表面），
  // 不属于上游协议细节，故不在检查列表中。
  for (const pattern of [
    "agentId",
    "environmentId",
    "jobToken",
    "agent_chat",
    "qmodel",
    "stream-json",
    "status_idle",
  ]) {
    if (text.includes(pattern)) leaks.push(`${rel} contains "${pattern}"`);
  }
}
console.log(leaks.length ? leaks.join("\n") : "NO PROTOCOL DETAIL LEAKS IN SERVER");
