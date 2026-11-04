/** RFC 4180 CSV serializer used by local exports. */
export function toCsv(rows: readonly (readonly unknown[])[]): string {
  const body = rows.map(row => row.map(value => quoteCell(value)).join(',')).join('\r\n');
  return `\uFEFF${body}${rows.length ? '\r\n' : ''}`;
}

function quoteCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}
