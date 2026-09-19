import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../src/server.js';

test('serves /v1/models and non-stream chat completion', async () => {
  const fakeQoder = {
    async createSession() { return 'sess_1'; },
    async runTurn({ onDelta }) {
      onDelta?.('hello');
      return 'hello';
    },
    async archiveSession() {},
  };
  const config = {
    host: '127.0.0.1',
    port: 0,
    proxyApiKey: 'local-key',
    qoderAccessToken: 'qoder-token',
    qoderApiBaseUrl: 'https://api.qoder.com/api/v1/cloud',
    requestTimeoutMs: 1000,
    archiveEphemeralSessions: true,
    sessionTtlMs: 1000,
    modelMap: { cc: { modelId: 'cc', agentId: 'agent', environmentId: 'env', title: 'test', metadata: {} } },
  };
  const server = createServer(config, { qoderClient: fakeQoder });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const models = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: 'Bearer local-key' } });
    assert.equal(models.status, 200);
    assert.equal((await models.json()).data[0].id, 'cc');

    const completion = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cc', messages: [{ role: 'user', content: 'Say hi' }] }),
    });
    assert.equal(completion.status, 200);
    const json = await completion.json();
    assert.equal(json.choices[0].message.content, 'hello');
  } finally {
    server.close();
  }
});

test('serves Anthropic /v1/messages shape for CC Switch style clients', async () => {
  const fakeQoder = {
    async createSession() { return 'sess_2'; },
    async runTurn() { return 'anthropic hello'; },
    async archiveSession() {},
  };
  const config = {
    host: '127.0.0.1',
    port: 0,
    proxyApiKey: '',
    qoderAccessToken: 'qoder-token',
    qoderApiBaseUrl: 'https://api.qoder.com/api/v1/cloud',
    requestTimeoutMs: 1000,
    archiveEphemeralSessions: true,
    sessionTtlMs: 1000,
    modelMap: { cc: { modelId: 'cc', agentId: 'agent', environmentId: 'env', title: 'test', metadata: {} } },
  };
  const server = createServer(config, { qoderClient: fakeQoder });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cc', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.type, 'message');
    assert.equal(json.content[0].text, 'anthropic hello');
  } finally {
    server.close();
  }
});
