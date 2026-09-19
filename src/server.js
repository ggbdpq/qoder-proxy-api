import http from 'node:http';
import { loadConfig, publicConfig } from './config.js';
import { HttpError, parseUrl, readJsonBody, requireBearer, setCors, writeJson, writeOpenAIError } from './http.js';
import {
  buildChatCompletion,
  buildResponsesCompletion,
  chatCompletionId,
  contentToText,
  formatMessagesAsPrompt,
  openAIModelsResponse,
} from './openai.js';
import { QoderClient, SessionStore } from './qoder-client.js';

export function createServer(config = loadConfig(), deps = {}) {
  const client = deps.qoderClient || new QoderClient({
    baseUrl: config.qoderApiBaseUrl,
    accessToken: config.qoderAccessToken,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const sessions = deps.sessionStore || new SessionStore({ ttlMs: config.sessionTtlMs });

  return http.createServer(async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = parseUrl(req);
      if (req.method === 'GET' && url.pathname === '/health') {
        writeJson(res, 200, { ok: true, config: publicConfig(config) });
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
        requireBearer(req, config.proxyApiKey);
        writeJson(res, 200, openAIModelsResponse(config.modelMap));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        requireBearer(req, config.proxyApiKey);
        const body = await readJsonBody(req);
        await handleChatCompletions({ req, res, body, config, client, sessions });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/responses') {
        requireBearer(req, config.proxyApiKey);
        const body = await readJsonBody(req);
        await handleResponses({ req, res, body, config, client, sessions });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        requireBearer(req, config.proxyApiKey);
        const body = await readJsonBody(req);
        await handleAnthropicMessages({ req, res, body, config, client, sessions });
        return;
      }

      writeOpenAIError(res, 404, `route not found: ${req.method} ${url.pathname}`, 'not_found_error');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      writeOpenAIError(res, status, error.message || 'internal server error', status >= 500 ? 'server_error' : 'invalid_request_error', error.details);
    }
  });
}

async function handleChatCompletions(ctx) {
  const { req, res, body } = ctx;
  const model = requireModel(ctx.config, body.model);
  const prompt = formatMessagesAsPrompt(body.messages);
  if (!prompt) throw new HttpError(400, 'messages must contain at least one text message');

  const id = chatCompletionId('chatcmpl');
  if (body.stream) {
    beginSse(res);
    writeSse(res, {
      id,
      object: 'chat.completion.chunk',
      created: unixNow(),
      model: model.modelId,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });
    await runQoder(ctx, model, prompt, (delta) => {
      writeSse(res, {
        id,
        object: 'chat.completion.chunk',
        created: unixNow(),
        model: model.modelId,
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      });
    });
    writeSse(res, {
      id,
      object: 'chat.completion.chunk',
      created: unixNow(),
      model: model.modelId,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const text = await runQoder(ctx, model, prompt);
  writeJson(res, 200, buildChatCompletion({ id, model: model.modelId, text }));
}

async function handleResponses(ctx) {
  const { res, body } = ctx;
  const model = requireModel(ctx.config, body.model);
  const prompt = responsesInputToPrompt(body.input, body.instructions);
  if (!prompt) throw new HttpError(400, 'input must contain text');

  const id = chatCompletionId('resp');
  if (body.stream) {
    beginSse(res);
    writeSse(res, { type: 'response.created', response: { id, object: 'response', status: 'in_progress', model: model.modelId } });
    await runQoder(ctx, model, prompt, (delta) => {
      writeSse(res, { type: 'response.output_text.delta', response_id: id, item_id: `msg_${id}`, output_index: 0, content_index: 0, delta });
    });
    writeSse(res, { type: 'response.output_text.done', response_id: id, item_id: `msg_${id}`, output_index: 0, content_index: 0 });
    writeSse(res, { type: 'response.completed', response: { id, object: 'response', status: 'completed', model: model.modelId } });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const text = await runQoder(ctx, model, prompt);
  writeJson(res, 200, buildResponsesCompletion({ id, model: model.modelId, text }));
}

async function handleAnthropicMessages(ctx) {
  const { res, body } = ctx;
  const model = requireModel(ctx.config, body.model);
  const prompt = anthropicInputToPrompt(body);
  if (!prompt) throw new HttpError(400, 'messages must contain text');

  const id = chatCompletionId('msg');
  if (body.stream) {
    beginSse(res);
    writeAnthropicSse(res, 'message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: model.modelId,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    writeAnthropicSse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    await runQoder(ctx, model, prompt, (delta) => {
      writeAnthropicSse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } });
    });
    writeAnthropicSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    writeAnthropicSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } });
    writeAnthropicSse(res, 'message_stop', { type: 'message_stop' });
    res.end();
    return;
  }

  const text = await runQoder(ctx, model, prompt);
  writeJson(res, 200, {
    id,
    type: 'message',
    role: 'assistant',
    model: model.modelId,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
}

async function runQoder({ req, body, config, client, sessions }, model, prompt, onDelta) {
  const sessionKey = getSessionKey(req, body);
  let sessionId = sessions.get(sessionKey);
  let ephemeral = false;

  if (!sessionId) {
    sessionId = await client.createSession(model, {
      title: body?.metadata?.title || body?.title,
      metadata: { downstream: 'compatible-api', session_key: sessionKey || undefined },
    });
    if (!sessionId) throw new Error('Qoder did not return a session id');
    if (sessionKey) sessions.set(sessionKey, sessionId);
    else ephemeral = true;
  }

  try {
    return await client.runTurn({ sessionId, prompt, onDelta });
  } finally {
    if (ephemeral && config.archiveEphemeralSessions) {
      await client.archiveSession(sessionId);
    }
  }
}

function requireModel(config, modelId) {
  const id = String(modelId || Object.keys(config.modelMap)[0] || '').trim();
  const spec = config.modelMap[id];
  if (!spec) throw new HttpError(400, `unknown model: ${id}`);
  return spec;
}

function responsesInputToPrompt(input, instructions = '') {
  const lines = [];
  if (instructions) lines.push(`System: ${instructions}`);
  if (typeof input === 'string') lines.push(`User: ${input}`);
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') lines.push(`User: ${item}`);
      else if (item?.role || item?.content) lines.push(`${capitalize(item.role || 'user')}: ${contentToText(item.content || item.text || item)}`);
    }
  }
  return lines.filter(Boolean).join('\n\n');
}

function anthropicInputToPrompt(body) {
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: body.system });
  for (const msg of body.messages || []) messages.push(msg);
  return formatMessagesAsPrompt(messages);
}

function getSessionKey(req, body) {
  const header = req.headers['x-qoder-session-id'];
  if (header) return String(header).trim();
  return String(
    body?.metadata?.qoder_session_id ||
    body?.metadata?.session_id ||
    body?.conversation ||
    body?.conversation_id ||
    body?.user ||
    '',
  ).trim();
}

function beginSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

function writeSse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeAnthropicSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function capitalize(value) {
  const raw = String(value || 'user');
  return `${raw.slice(0, 1).toUpperCase()}${raw.slice(1)}`;
}
