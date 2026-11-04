/** RFC 4180 CSV serializer used by local exports. */
export function toCsv(rows: readonly (readonly unknown[])[]): string {
  const body = rows.map(row => row.map(value => quoteCell(value)).join(',')).join('\r\n');
  return `\uFEFF${body}${rows.length ? '\r\n' : ''}`;
}

export interface ParsedCsv {
  delimiter: ',' | ';' | '\t';
  headers: string[];
  rows: string[][];
}

export interface ParseCsvOptions {
  delimiter?: ',' | ';' | '\t';
  maxBytes?: number;
  maxRows?: number;
}

/** Bounded RFC 4180 parser for local imports. */
export function parseCsv(input: string, options: ParseCsvOptions = {}): ParsedCsv {
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxRows = options.maxRows ?? 5000;
  if (new TextEncoder().encode(input).byteLength > maxBytes) throw new Error(`CSV exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB limit.`);
  const text = input.replace(/^\uFEFF/, '');
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"' && cell === '') { quoted = true; continue; }
    if (char === delimiter) { row.push(cell); cell = ''; continue; }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some(value => value !== '')) {
        rows.push(row);
        if (rows.length > maxRows + 1) throw new Error(`CSV exceeds the ${maxRows.toLocaleString()} row limit.`);
      }
      row = [];
      continue;
    }
    cell += char;
  }
  if (quoted) throw new Error('CSV has an unterminated quoted cell.');
  if (cell !== '' || row.length) {
    row.push(cell);
    if (row.some(value => value !== '')) rows.push(row);
  }
  if (rows.length < 1) throw new Error('CSV has no header row.');
  const headers = rows.shift()!.map((value, index) => value.trim() || `Column ${index + 1}`);
  if (new Set(headers.map(normalizeHeader)).size !== headers.length) throw new Error('CSV has duplicate column headers.');
  return { delimiter, headers, rows };
}

function detectDelimiter(text: string): ',' | ';' | '\t' {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const candidates: Array<[',' | ';' | '\t', number]> = [[',', 0], [';', 0], ['\t', 0]];
  for (const [delimiter] of candidates) {
    let quoted = false;
    for (let i = 0; i < firstLine.length; i += 1) {
      if (firstLine[i] === '"') quoted = !quoted;
      else if (!quoted && firstLine[i] === delimiter) candidates.find(item => item[0] === delimiter)![1] += 1;
    }
  }
  return candidates.sort((a, b) => b[1] - a[1])[0][0];
}

export function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, '');
}

function quoteCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}
