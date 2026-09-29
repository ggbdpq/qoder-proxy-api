#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const BASE_URL = (process.env.QODER_API_BASE_URL || 'https://api.qoder.com').replace(/\/+$/, '') + '/api/v1/cloud';
const AGENT_NAME = process.env.QODER_SETUP_AGENT_NAME || 'qoder-proxy-agent';
const ENV_NAME = process.env.QODER_SETUP_ENV_NAME || 'default';

function maybeLoadEnv() {
  if (!existsSync('.env')) return;
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile('.env');
  }
}

async function readToken() {
  if (process.env.QODER_ACCESS_TOKEN) return process.env.QODER_ACCESS_TOKEN.trim();
  if (!process.argv.includes('--stdin-token')) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim().split(/\r?\n/)[0]?.trim() || '';
}

async function request(token, path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: options.method || 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const message = json?.message || json?.error?.message || json?.error || text || res.statusText;
    throw new Error(`Qoder HTTP ${res.status}: ${message}`);
  }
  return json;
}

function dataArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

async function getOrCreateEnvironment(token) {
  const existing = dataArray(await request(token, '/environments'));
  const env = existing.find((item) => item?.name === ENV_NAME) || existing[0];
  if (env?.id) return { id: env.id, name: env.name || ENV_NAME, created: false };
  const created = await request(token, '/environments', { method: 'POST', body: { name: ENV_NAME } });
  return { id: created.id || created?.data?.id, name: created.name || ENV_NAME, created: true };
}

async function getOrCreateAgent(token) {
  const existing = dataArray(await request(token, '/agents'));
  const agent = existing.find((item) => item?.name === AGENT_NAME) || existing[0];
  if (agent?.id) return { id: agent.id, name: agent.name || AGENT_NAME, model: agent.model, created: false };
  const created = await request(token, '/agents', {
    method: 'POST',
    body: {
      name: AGENT_NAME,
      model: 'ultimate',
      system: 'You are an efficient programming assistant skilled at writing code and troubleshooting issues.',
      tools: [
        {
          type: 'agent_toolset_20260401',
          enabled_tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
        },
      ],
    },
  });
  return { id: created.id || created?.data?.id, name: created.name || AGENT_NAME, model: created.model, created: true };
}

function requireId(label, value) {
  if (!value) throw new Error(`missing ${label} in Qoder response`);
  return value;
}

maybeLoadEnv();
const token = await readToken();
if (!token) throw new Error('QODER_ACCESS_TOKEN is empty');

const environment = await getOrCreateEnvironment(token);
const agent = await getOrCreateAgent(token);
requireId('environment id', environment.id);
requireId('agent id', agent.id);

const proxyApiKey = process.env.PROXY_API_KEY || `qpa_${randomBytes(18).toString('base64url')}`;
const envText = [
  `QODER_ACCESS_TOKEN=${token}`,
  `QODER_AGENT_ID=${agent.id}`,
  `QODER_ENVIRONMENT_ID=${environment.id}`,
  `PROXY_API_KEY=${proxyApiKey}`,
  'HOST=127.0.0.1',
  'PORT=8320',
  'QODER_MODEL_ID=qoder-agent-default',
  '',
].join('\n');
writeFileSync('.env', envText, { encoding: 'utf8', mode: 0o600 });

console.log(JSON.stringify({
  ok: true,
  envFile: '.env',
  environment: { id: environment.id, name: environment.name, created: environment.created },
  agent: { id: agent.id, name: agent.name, model: agent.model, created: agent.created },
  proxyApiKey: `${proxyApiKey.slice(0, 8)}...`,
}, null, 2));
