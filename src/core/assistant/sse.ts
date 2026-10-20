/* Pure `text/event-stream` parsing for the embedded assistant (no DOM, no
 * store, no Dexie — unit-tested in tests/assistant-ui-sse.test.ts).
 *
 * Feed decoded text chunks in arrival order; complete events come back as
 * validated `AssistantEvent`s. Chunks may split anywhere (mid-line, mid-CRLF,
 * mid-JSON). Malformed lines/payloads and unknown event types are dropped:
 * the stream is server output, but a proxy or partial write must never crash
 * the UI or inject an unexpected shape. */
import type { AssistantEvent } from '../../../shared/assistantProtocol';

const EVENT_TYPES = new Set(['run', 'message', 'text', 'tool', 'sources', 'approval', 'step_end', 'error']);
const NEXT = new Set(['continue', 'done', 'approval', 'cancelled']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';

/** Minimal structural validation of one decoded payload. */
export function asAssistantEvent(v: unknown): AssistantEvent | null {
  if (!isObj(v) || !str(v.type) || !EVENT_TYPES.has(v.type)) return null;
  switch (v.type) {
    case 'run':
      return str(v.runId) && str(v.conversationId) ? (v as unknown as AssistantEvent) : null;
    case 'message':
      return isObj(v.message) && str(v.message.id) && str(v.message.role) && str(v.message.text) ? (v as unknown as AssistantEvent) : null;
    case 'text':
      return str(v.messageId) && str(v.delta) ? (v as unknown as AssistantEvent) : null;
    case 'tool':
      return str(v.messageId) && isObj(v.call) && str(v.call.id) ? (v as unknown as AssistantEvent) : null;
    case 'sources':
      return str(v.messageId) && Array.isArray(v.sources) ? (v as unknown as AssistantEvent) : null;
    case 'approval':
      return str(v.messageId) && isObj(v.approval) && str(v.approval.previewId) && str(v.approval.argsHash) ? (v as unknown as AssistantEvent) : null;
    case 'step_end':
      return str(v.runId) && typeof v.step === 'number' && str(v.next) && NEXT.has(v.next) ? (v as unknown as AssistantEvent) : null;
    case 'error':
      return str(v.code) && str(v.message) ? ({ ...v, retryable: v.retryable === true } as unknown as AssistantEvent) : null;
  }
  return null;
}

function decode(data: string[]): AssistantEvent[] {
  if (!data.length) return [];
  const joined = data.join('\n');
  try {
    const ev = asAssistantEvent(JSON.parse(joined));
    return ev ? [ev] : [];
  } catch {
    // Tolerate a writer that omitted the blank-line separator: each `data:`
    // line is then a standalone JSON document.
    if (data.length < 2) return [];
    const out: AssistantEvent[] = [];
    for (const line of data) {
      try {
        const ev = asAssistantEvent(JSON.parse(line));
        if (ev) out.push(ev);
      } catch {
        /* malformed line — ignored */
      }
    }
    return out;
  }
}

export interface SseParser {
  /** Feed the next decoded chunk; returns the events completed by it. */
  push(chunk: string): AssistantEvent[];
  /** End of stream: dispatch a trailing event that lacked its blank line. */
  end(): AssistantEvent[];
}

export function createSseParser(): SseParser {
  let buf = '';
  let data: string[] = [];
  /** A chunk ended in '\r' — a following '\n' belongs to the same line break. */
  let pendingCR = false;

  const line = (l: string, out: AssistantEvent[]) => {
    if (l === '') {
      out.push(...decode(data));
      data = [];
      return;
    }
    if (l.startsWith(':')) return; // comment / keep-alive
    const colon = l.indexOf(':');
    const field = colon < 0 ? l : l.slice(0, colon);
    if (field !== 'data') return; // event/id/retry are not used by this protocol
    let value = colon < 0 ? '' : l.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    data.push(value);
  };

  return {
    push(chunk) {
      const out: AssistantEvent[] = [];
      let text = chunk;
      if (pendingCR && text.startsWith('\n')) text = text.slice(1);
      pendingCR = false;
      buf += text;
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const c = buf[i];
        if (c !== '\n' && c !== '\r') continue;
        line(buf.slice(start, i), out);
        if (c === '\r') {
          if (i + 1 < buf.length) {
            if (buf[i + 1] === '\n') i++;
          } else pendingCR = true;
        }
        start = i + 1;
      }
      buf = buf.slice(start);
      // Defensive bound: a single unterminated line larger than 4 MiB is not
      // a valid assistant event; drop it instead of growing without limit.
      if (buf.length > 4 * 1024 * 1024) buf = '';
      return out;
    },
    end() {
      const out: AssistantEvent[] = [];
      if (buf) line(buf, out);
      buf = '';
      out.push(...decode(data));
      data = [];
      return out;
    },
  };
}
