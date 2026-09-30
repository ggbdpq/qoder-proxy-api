#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { createApp, resolveProviderId } from "./bootstrap.ts";
import { createServer } from "./server/server.ts";
import { publicConfig } from "./config.ts";

function loadDotEnv(path = ".env") {
  if (!existsSync(path)) return;
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(path);
    return;
  }
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const providerId = resolveProviderId();
const app = createApp({ providerId });
const server = createServer(app.config, {
  providerRegistry: app.registry,
  modelRoutes: app.modelRoutes,
  defaultProviderId: app.defaultProviderId,
});

server.listen(app.config.port, app.config.host, () => {
  const shown = publicConfig(app.config);
  console.log(`qoder-proxy-api listening on http://${app.config.host}:${app.config.port}`);
  console.log(
    `provider: ${providerId} (npm start 默认 gateway；--provider=cli|cloudAgents 可切换)`,
  );
  if (providerId === "cloudAgents") {
    console.log(`models: ${Object.keys(app.config.modelMap).join(", ")}`);
    console.log(`qoder cloud base: ${shown.qoderApiBaseUrl}`);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
