export function parseSseChunk(buffer, chunkText) {
  const text = buffer + chunkText;
  const normalized = text.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const remainder = parts.pop() ?? '';
  const events = parts.map(parseSseBlock).filter(Boolean);
  return { events, remainder };
}

export function parseSseBlock(block) {
  const event = { id: '', event: 'message', data: '' };
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const sep = line.indexOf(':');
    const field = sep === -1 ? line : line.slice(0, sep);
    const value = sep === -1 ? '' : line.slice(sep + 1).replace(/^ /, '');
    if (field === 'id') event.id = value;
    else if (field === 'event') event.event = value || 'message';
    else if (field === 'data') dataLines.push(value);
  }
  event.data = dataLines.join('\n');
  return event;
}

export function decodeSseData(data) {
  if (data == null || data === '' || data === '[DONE]') return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}
