import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCloudBaseUrl, normalizeModelMap, parseModelMap } from '../src/config.js';
import { extractTextDelta, formatMessagesAsPrompt } from '../src/openai.js';
import { parseSseChunk } from '../src/sse.js';

test('normalizes Qoder cloud base URL variants', () => {
  assert.equal(normalizeCloudBaseUrl('https://api.qoder.com'), 'https://api.qoder.com/api/v1/cloud');
  assert.equal(normalizeCloudBaseUrl('https://api.qoder.com/api/v1'), 'https://api.qoder.com/api/v1/cloud');
  assert.equal(normalizeCloudBaseUrl('https://api.qoder.com/api/v1/cloud/'), 'https://api.qoder.com/api/v1/cloud');
});

test('parses model map from inline JSON', () => {
  const models = parseModelMap({
    QODER_MODEL_MAP: JSON.stringify({ cc: { agent_id: 'agent_1', environment_id: 'env_1', agent_version: 2 } }),
  });
  assert.deepEqual(models.cc.agentId, 'agent_1');
  assert.deepEqual(models.cc.environmentId, 'env_1');
  assert.deepEqual(models.cc.agentVersion, 2);
});

test('normalizes model map keys and metadata', () => {
  const models = normalizeModelMap({ ' qoder ': { agentId: ' a ', environmentId: ' e ', metadata: { a: 1 } } });
  assert.equal(models.qoder.agentId, 'a');
  assert.equal(models.qoder.environmentId, 'e');
  assert.deepEqual(models.qoder.metadata, { a: 1 });
});

test('formats OpenAI chat messages into Qoder prompt text', () => {
  const prompt = formatMessagesAsPrompt([
    { role: 'system', content: 'Be short.' },
    { role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'image_url', image_url: { url: 'https://example.test/a.png' } }] },
  ]);
  assert.match(prompt, /System: Be short\./);
  assert.match(prompt, /User: Hello\n\[image:/);
});

test('parses SSE chunks with remainder', () => {
  const first = parseSseChunk('', 'event: a\ndata: {"x":1}\n\nevent: b\ndata:');
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].event, 'a');
  const second = parseSseChunk(first.remainder, ' {"y":2}\n\n');
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].event, 'b');
});

test('extracts text deltas from likely Qoder event shapes', () => {
  assert.equal(extractTextDelta({ event: 'agent.message.delta', json: { delta: { text: 'hi' } } }), 'hi');
  assert.equal(extractTextDelta({ event: 'agent.message', json: { content: [{ type: 'text', text: 'full' }] } }, { fullTextsSeen: new Set() }), 'full');
});
