/* global AbortController, TextDecoder, fetch, setTimeout */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FrameParser {
  buffer = '';
  event = null;
  data = null;
  // Only an id on this frame marks a durable event; the last event id persists across frames.
  frameId = null;

  constructor(record, onEvent) {
    this.record = record;
    this.onEvent = onEvent;
  }

  dispatch() {
    if (this.data === null) {
      this.event = null;
      this.frameId = null;
      return;
    }
    const frame = { id: this.frameId, event: this.event, data: this.data };
    this.event = null;
    this.data = null;
    this.frameId = null;
    if (frame.id === null) this.record.controlFrames.push({ event: frame.event, data: frame.data });
    else {
      this.record.events.push(frame);
      this.record.lastEventId = frame.id;
    }
    this.onEvent?.(frame);
  }

  consume(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.search(/\r\n|\r|\n/)) !== -1) {
      const terminator = this.buffer.startsWith('\r\n', index) ? 2 : 1;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + terminator);
      this.consumeLine(line);
    }
  }

  consumeLine(line) {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) {
      this.record.comments += 1;
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data = this.data === null ? value : `${this.data}\n${value}`;
    else if (field === 'id') this.frameId = value;
  }
}

export async function stream({ url, headers, lastEventId, stopAfterMs, onEvent }) {
  const controller = new AbortController();
  if (lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId;

  const requestedAt = Date.now();
  const response = await fetch(url, { headers, signal: controller.signal });
  const headersAt = Date.now();

  const record = {
    status: response.status,
    contentType: response.headers.get('content-type'),
    contentEncoding: response.headers.get('content-encoding'),
    transferEncoding: response.headers.get('transfer-encoding'),
    xAccelBuffering: response.headers.get('x-accel-buffering'),
    ttfbMs: headersAt - requestedAt,
    chunks: 0,
    maxGapMs: 0,
    events: [],
    controlFrames: [],
    comments: 0,
    lastEventId,
    clean: false,
    error: null,
  };
  if (response.status !== 200 || response.body === null) {
    record.error = `status ${String(response.status)}`;
    return record;
  }

  return consumeResponse({ response, record, controller, headersAt, stopAfterMs, onEvent });
}

async function consumeResponse({ response, record, controller, headersAt, stopAfterMs, onEvent }) {
  const stopAt = stopAfterMs === undefined ? Infinity : Date.now() + stopAfterMs;
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let previousChunkAt = headersAt;
  const parser = new FrameParser(record, onEvent);

  try {
    for (;;) {
      const result = await readUntilDeadline(reader, stopAt);
      if (result === 'DEADLINE') {
        record.clean = true;
        controller.abort();
        break;
      }
      if (result.done) {
        record.clean = true;
        break;
      }
      const now = Date.now();
      record.maxGapMs = Math.max(record.maxGapMs, now - previousChunkAt);
      previousChunkAt = now;
      record.chunks += 1;

      parser.consume(decoder.decode(result.value, { stream: true }));
    }
  } catch (cause) {
    record.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // the stream is already gone
    }
  }
  return record;
}

function readUntilDeadline(reader, stopAt) {
  const readPromise = reader.read();
  const remaining = stopAt - Date.now();
  return remaining === Infinity
    ? readPromise
    : Promise.race([readPromise, sleep(Math.max(remaining, 0)).then(() => 'DEADLINE')]);
}
