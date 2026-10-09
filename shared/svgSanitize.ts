/* Safe SVG sanitizer (Phase 2 §2): a tolerant XML tokenizer + allowlist
 * serializer that runs without DOM APIs so it works in Cloudflare Workers.
 * Anything not explicitly allowed — script, event handlers, external refs,
 * foreignObject, DOCTYPE/entities, non-# url() — is dropped; oversized or
 * malformed input is rejected. Output is a canonical single-<svg> string
 * safe to serve as image/svg+xml (rendered via <img> only). */

export type SanitizeResult = { ok: true; svg: string } | { ok: false; reasons: string[] };

export const SVG_MAX_BYTES = 1024 * 1024;
export const SVG_MAX_NODES = 20_000;

const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'linearGradient', 'radialGradient', 'stop',
  'clipPath', 'mask', 'title', 'desc', 'use', 'symbol',
]);

const ALLOWED_ATTRS = new Set([
  'fill', 'stroke', 'stroke-width', 'opacity', 'transform', 'viewBox',
  'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'x2', 'y1', 'y2',
  'points', 'd', 'width', 'height', 'text-anchor', 'offset',
  'stop-color', 'stop-opacity', 'clip-path', 'gradientUnits',
  'gradientTransform', 'spreadMethod', 'id', 'class', 'xml:space',
  'href', 'xlink:href', 'style',
]);

const SVG_XMLNS = 'http://www.w3.org/2000/svg';
const XLINK_XMLNS = 'http://www.w3.org/1999/xlink';

const isWs = (c: string) => c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f';
const isNameStart = (c: string) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_' || c === ':';

interface El {
  name: string;
  attrs: [string, string][];
  children: Child[];
}
interface Text {
  text: string;
  cdata?: boolean;
}
type Child = El | Text;

/** Decode the five named entities + numeric refs in one pass; anything else is dropped. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (_m, body: string) => {
    if (body === 'amp') return '&';
    if (body === 'lt') return '<';
    if (body === 'gt') return '>';
    if (body === 'quot') return '"';
    if (body === 'apos') return "'";
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return ''; // unknown/DOCTYPE-declared entity — never expanded
  });
}

/** True when every url( in the value targets a #fragment; false for any external ref. */
function urlsOnlyFragments(v: string): boolean {
  const re = /url\(\s*['"]?\s*/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(v))) {
    if (v[m.index + m[0].length] !== '#') return false;
  }
  return true;
}

const STYLE_DENY = ['expression(', 'javascript:', 'vbscript:', '@import', 'behavior:', '-moz-binding', 'binding:'];

function styleOk(v: string): boolean {
  const low = v.toLowerCase();
  if (STYLE_DENY.some((bad) => low.includes(bad))) return false;
  return urlsOnlyFragments(v);
}

function attrAllowed(name: string, value: string): boolean {
  if (/^on/i.test(name)) return false; // event handlers — belt & braces (allowlist drops them anyway)
  if (!ALLOWED_ATTRS.has(name) && !name.startsWith('font-')) return false;
  if (name === 'href' || name === 'xlink:href') return value.trimStart().startsWith('#');
  if (name === 'style') return styleOk(value);
  return urlsOnlyFragments(value);
}

/**
 * Tokenize into a tolerant element tree. Comments, PIs, DOCTYPE/entity
 * declarations are dropped; CDATA becomes a raw text node; stray close tags
 * and unclosed elements are absorbed; '<' not starting a tag is literal text.
 */
function tokenize(input: string): { root: El } | { error: string } {
  const root: El = { name: '#root', attrs: [], children: [] };
  const stack: El[] = [root];
  let nodes = 0;
  let i = 0;
  const n = input.length;
  const bump = () => {
    nodes++;
    return nodes > SVG_MAX_NODES;
  };
  while (i < n) {
    if (input[i] !== '<') {
      const j = input.indexOf('<', i);
      const text = input.slice(i, j === -1 ? n : j);
      stack[stack.length - 1].children.push({ text });
      if (bump()) return { error: `exceeds ${SVG_MAX_NODES} nodes` };
      i = j === -1 ? n : j;
      continue;
    }
    if (input.startsWith('<!--', i)) {
      const j = input.indexOf('-->', i + 4);
      i = j === -1 ? n : j + 3;
      continue;
    }
    if (input.startsWith('<![CDATA[', i)) {
      const j = input.indexOf(']]>', i + 9);
      const text = j === -1 ? input.slice(i + 9) : input.slice(i + 9, j);
      stack[stack.length - 1].children.push({ text, cdata: true });
      if (bump()) return { error: `exceeds ${SVG_MAX_NODES} nodes` };
      i = j === -1 ? n : j + 3;
      continue;
    }
    if (input.startsWith('<!', i)) {
      // DOCTYPE / <!ENTITY …> / bogus markup — dropped, internal subset […] skipped correctly
      let j = i + 2;
      while (j < n && input[j] !== '>') {
        if (input[j] === '[') {
          const k = input.indexOf(']', j);
          j = k === -1 ? n : k + 1;
        } else {
          j++;
        }
      }
      i = j >= n ? n : j + 1;
      continue;
    }
    if (input.startsWith('<?', i)) {
      const j = input.indexOf('?>', i + 2);
      i = j === -1 ? n : j + 2;
      continue;
    }
    if (input.startsWith('</', i)) {
      let j = i + 2;
      while (j < n && !isWs(input[j]) && input[j] !== '>') j++;
      const name = input.slice(i + 2, j);
      const gt = input.indexOf('>', j);
      i = gt === -1 ? n : gt + 1;
      if (name) {
        // Pop to the matching open element (auto-closing unclosed inner ones); stray closes are ignored.
        for (let k = stack.length - 1; k >= 1; k--) {
          if (stack[k].name === name) {
            stack.length = k;
            break;
          }
        }
      }
      continue;
    }
    const c = input[i + 1];
    if (c === undefined || !isNameStart(c)) {
      stack[stack.length - 1].children.push({ text: '<' });
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && !isWs(input[j]) && input[j] !== '>' && input[j] !== '/') j++;
    const name = input.slice(i + 1, j);
    const attrs: [string, string][] = [];
    let selfClose = false;
    let malformed = false;
    let sawGt = false;
    while (j < n) {
      while (j < n && isWs(input[j])) j++;
      if (j >= n) {
        malformed = true;
        break;
      }
      if (input[j] === '>') {
        j++;
        sawGt = true;
        break;
      }
      if (input[j] === '/') {
        if (input[j + 1] === '>') {
          selfClose = true;
          j += 2;
          sawGt = true;
          break;
        }
        j++;
        continue; // stray '/' inside a tag — tolerated
      }
      const aStart = j;
      while (j < n && !isWs(input[j]) && input[j] !== '=' && input[j] !== '>' && input[j] !== '/') j++;
      const aName = input.slice(aStart, j);
      while (j < n && isWs(input[j])) j++;
      let aVal = '';
      if (input[j] === '=') {
        j++;
        while (j < n && isWs(input[j])) j++;
        if (j >= n) {
          malformed = true;
          break;
        }
        const q = input[j];
        if (q === '"' || q === "'") {
          const e = input.indexOf(q, j + 1);
          if (e === -1) {
            malformed = true;
            break;
          }
          aVal = input.slice(j + 1, e);
          j = e + 1;
        } else {
          const vStart = j;
          while (j < n && !isWs(input[j]) && input[j] !== '>') j++;
          aVal = input.slice(vStart, j);
        }
      }
      if (aName) attrs.push([aName, aVal]);
    }
    if (bump()) return { error: `exceeds ${SVG_MAX_NODES} nodes` };
    if (malformed || !sawGt) break; // tag ran into EOF without '>' — drop it
    i = j;
    const el: El = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!selfClose) stack.push(el);
  }
  return { root };
}

/** Keep allowlisted elements only — anything else is dropped with its whole subtree. */
function filterEl(el: El): El | null {
  if (!ALLOWED_ELEMENTS.has(el.name)) return null;
  const seen = new Set<string>();
  const attrs: [string, string][] = [];
  for (const [name, raw] of el.attrs) {
    if (seen.has(name)) continue;
    const value = decodeEntities(raw);
    if (!attrAllowed(name, value)) continue;
    seen.add(name);
    attrs.push([name, value]);
  }
  const children: Child[] = [];
  for (const c of el.children) {
    if ('name' in c) {
      const f = filterEl(c);
      if (f) children.push(f);
    } else {
      children.push({ text: c.cdata ? c.text : decodeEntities(c.text), cdata: c.cdata });
    }
  }
  return { name: el.name, attrs, children };
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;');

function serialize(el: El): string {
  const attrs = [...el.attrs]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([n, v]) => ` ${n}="${escapeAttr(v)}"`)
    .join('');
  if (!el.children.length) return `<${el.name}${attrs}/>`;
  const inner = el.children
    .map((c) => ('name' in c ? serialize(c) : escapeText(c.text)))
    .join('');
  return `<${el.name}${attrs}>${inner}</${el.name}>`;
}

function walk(el: El, fn: (e: El) => void): void {
  fn(el);
  for (const c of el.children) if ('name' in c) walk(c, fn);
}

/**
 * Sanitize an SVG document. Drops disallowed elements/attributes (with their
 * subtrees); rejects fatally when input exceeds limits or has no <svg> root.
 */
export function sanitizeSvg(input: unknown): SanitizeResult {
  if (typeof input !== 'string') return { ok: false, reasons: ['input-not-string'] };
  if (new TextEncoder().encode(input).length > SVG_MAX_BYTES) {
    return { ok: false, reasons: [`input-exceeds-${SVG_MAX_BYTES}-bytes`] };
  }
  if (!input.trim()) return { ok: false, reasons: ['empty-input'] };
  const parsed = tokenize(input);
  if ('error' in parsed) return { ok: false, reasons: [parsed.error] };
  const svgEl = parsed.root.children.find((c): c is El => 'name' in c && c.name === 'svg');
  if (!svgEl) return { ok: false, reasons: ['no-svg-root'] };
  const filtered = filterEl(svgEl);
  if (!filtered) return { ok: false, reasons: ['no-svg-root'] };
  let usesXlink = false;
  walk(filtered, (e) => {
    if (e.attrs.some(([n]) => n === 'xlink:href')) usesXlink = true;
  });
  const rootAttrs: [string, string][] = [['xmlns', SVG_XMLNS]];
  if (usesXlink) rootAttrs.push(['xmlns:xlink', XLINK_XMLNS]);
  rootAttrs.push(...filtered.attrs);
  return { ok: true, svg: serialize({ name: 'svg', attrs: rootAttrs, children: filtered.children }) };
}
