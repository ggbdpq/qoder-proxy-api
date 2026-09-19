#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { loadConfig, publicConfig } from './config.js';
import { createServer } from './server.js';

function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(path);
    return;
  }
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const config = loadConfig();
const server = createServer(config);

server.listen(config.port, config.host, () => {
  const shown = publicConfig(config);
  console.log(`qoder-proxy-api listening on http://${config.host}:${config.port}`);
  console.log(`models: ${Object.keys(config.modelMap).join(', ')}`);
  console.log(`qoder cloud base: ${shown.qoderApiBaseUrl}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
