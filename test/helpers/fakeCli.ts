#!/usr/bin/env node
// fake qodercli：按 -p prompt 内容驱动行为，模拟 stream-json 输出。
// prompt 含 "hang" → 挂住；"exit3" → 退出码 3；否则输出标准 fixture 流。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const promptIndex = process.argv.indexOf("-p");
const prompt = promptIndex >= 0 ? (process.argv[promptIndex + 1] ?? "") : "";

if (prompt.includes("hang")) {
  setTimeout(() => process.exit(0), 30000);
} else if (prompt.includes("exit3")) {
  process.stderr.write("boom: simulated cli failure\n");
  process.exit(3);
} else {
  const lines = readFileSync(path.join(here, "..", "fixtures", "cli", "stream-json.jsonl"), "utf8");
  process.stdout.write(lines);
  process.exit(0);
}
