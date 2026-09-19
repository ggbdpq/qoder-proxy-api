const DIRECT_DELTA_PATHS = [
  ['delta', 'text'],
  ['delta', 'content'],
  ['delta', 'output_text'],
  ['event', 'delta', 'text'],
  ['event', 'delta', 'content'],
  ['message', 'delta', 'text'],
  ['message', 'delta', 'content'],
  ['text_delta'],
  ['partial_text'],
  ['content_delta', 'text'],
  ['output_text_delta'],
];

const FULL_TEXT_PATHS = [
  ['text'],
  ['content', 'text'],
  ['message', 'text'],
  ['message', 'content', 'text'],
  ['event', 'text'],
  ['event', 'content', 'text'],
];

export function formatMessagesAsPrompt(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return '';
  }

  const parts = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = normalizeRole(message.role);
    const text = contentToText(message.content);
    if (!text) continue;
    parts.push(`${role}: ${text}`);
  }
  return parts.join('\n\n');
}

export function chatCompletionId(prefix = 'chatcmpl') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function openAIModelsResponse(modelMap) {
  const now = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: Object.keys(modelMap).map((id) => ({
      id,
      object: 'model',
      created: now,
      owned_by: 'qoder-proxy-api',
    })),
  };
}

export function buildChatCompletion({ id, model, text, finishReason = 'stop' }) {
  const created = Math.floor(Date.now() / 1000);
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text || '' },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function buildResponsesCompletion({ id, model, text, status = 'completed' }) {
  const outputId = `msg_${id.replace(/[^a-zA-Z0-9_]/g, '')}`;
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: [
      {
        id: outputId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: text || '', annotations: [] }],
      },
    ],
    output_text: text || '',
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function extractTextDelta(sseEvent, state = {}) {
  const eventName = String(sseEvent?.event || '').toLowerCase();
  const data = sseEvent?.json ?? sseEvent?.data;
  if (data == null || data === '[DONE]') return '';

  if (typeof data === 'string') {
    if (looksLikeStatus(eventName) || looksLikeControl(data)) return '';
    return eventName.includes('delta') || eventName.includes('message') ? data : '';
  }

  for (const path of DIRECT_DELTA_PATHS) {
    const value = getPath(data, path);
    if (typeof value === 'string' && value) return value;
  }

  const contentDelta = extractFromContentArray(data?.delta?.content || data?.event?.delta?.content || data?.message?.delta?.content);
  if (contentDelta) return contentDelta;

  if (eventName.includes('delta')) {
    const anyDelta = findStringByKey(data, ['text', 'content', 'output_text', 'delta']);
    if (anyDelta) return anyDelta;
  }

  if (eventName.includes('agent.message') || eventName.includes('assistant.message') || data.type === 'agent.message') {
    const full = extractFullText(data);
    if (!full) return '';
    if (state.lastFullText && full.startsWith(state.lastFullText)) {
      const delta = full.slice(state.lastFullText.length);
      state.lastFullText = full;
      return delta;
    }
    if (state.fullTextsSeen?.has(full)) return '';
    state.fullTextsSeen ||= new Set();
    state.fullTextsSeen.add(full);
    state.lastFullText = full;
    return full;
  }

  return '';
}

export function isQoderIdleEvent(sseEvent) {
  const eventName = String(sseEvent?.event || '').toLowerCase();
  const type = String(sseEvent?.json?.type || '').toLowerCase();
  const status = String(sseEvent?.json?.status || '').toLowerCase();
  return eventName === 'session.status_idle' || type === 'session.status_idle' || status === 'idle';
}

export function isQoderRunningEvent(sseEvent) {
  const eventName = String(sseEvent?.event || '').toLowerCase();
  const type = String(sseEvent?.json?.type || '').toLowerCase();
  const status = String(sseEvent?.json?.status || '').toLowerCase();
  return eventName === 'session.status_running' || type === 'session.status_running' || status === 'running' || status === 'rescheduling';
}

export function extractQoderError(sseEvent) {
  const eventName = String(sseEvent?.event || '').toLowerCase();
  const data = sseEvent?.json ?? sseEvent?.data;
  if (!eventName.includes('error') && String(data?.type || '').toLowerCase() !== 'session.error') return null;
  if (typeof data === 'string') return data;
  return data?.error?.message || data?.message || JSON.stringify(data);
}

function normalizeRole(role) {
  const raw = String(role || 'user').toLowerCase();
  if (raw === 'developer') return 'Developer';
  if (raw === 'system') return 'System';
  if (raw === 'assistant') return 'Assistant';
  if (raw === 'tool') return 'Tool';
  return 'User';
}

export function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      if (part.type === 'image_url') return `[image: ${part.image_url?.url || 'attached'}]`;
      if (part.type === 'input_image') return `[image: ${part.image_url || part.file_id || 'attached'}]`;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
  }
  return '';
}

function extractFullText(data) {
  for (const path of FULL_TEXT_PATHS) {
    const value = getPath(data, path);
    if (typeof value === 'string' && value) return value;
  }
  return extractFromContentArray(data?.content || data?.message?.content || data?.event?.content) || '';
}

function extractFromContentArray(value) {
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    return part.text || part.output_text || part.content || '';
  }).filter(Boolean).join('');
}

function getPath(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function findStringByKey(value, keys) {
  if (!value || typeof value !== 'object') return '';
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findStringByKey(child, keys);
      if (found) return found;
    }
  }
  return '';
}

function looksLikeStatus(value) {
  return value.includes('status') || value.includes('heartbeat');
}

function looksLikeControl(value) {
  return ['idle', 'running', 'rescheduling', 'terminated'].includes(String(value).toLowerCase());
}
