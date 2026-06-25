// Tiny dependency-free CSV serializer for the admin waitlist export.
//
// Handles the cases that actually bite: values containing commas, quotes, or
// newlines get quoted/escaped per RFC 4180, and values that begin with a
// formula trigger (= + - @) are prefixed with a quote so spreadsheet apps don't
// execute them on open (CSV-injection defense). Dates serialize to ISO 8601.

export type CsvValue = string | number | boolean | Date | null | undefined;

function cell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else s = String(value);

  // Neutralize spreadsheet formula injection on text fields.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;

  // Quote when the value contains a delimiter, quote, or newline.
  if (/[",\r\n]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Serialize rows to a CSV string with a header line. `columns` fixes the order
 * and the header labels; each row is read by the same keys.
 */
export function toCsv<T extends Record<string, CsvValue>>(
  columns: { key: keyof T; header: string }[],
  rows: T[]
): string {
  const head = columns.map((c) => cell(c.header)).join(",");
  const body = rows.map((r) => columns.map((c) => cell(r[c.key])).join(","));
  // CRLF line endings per RFC 4180; trailing newline for POSIX-friendliness.
  return [head, ...body].join("\r\n") + "\r\n";
}

// ---- Incremental (streaming) variants ----
// Same byte output as toCsv(), but one line at a time so a large export can be
// streamed to the client without materializing the whole table in memory.

/** The CSV header line, CRLF-terminated. */
export function csvHeaderLine<T extends Record<string, CsvValue>>(
  columns: { key: keyof T; header: string }[]
): string {
  return columns.map((c) => cell(c.header)).join(",") + "\r\n";
}

/** A single CSV data line, CRLF-terminated. */
export function csvRowLine<T extends Record<string, CsvValue>>(
  columns: { key: keyof T; header: string }[],
  row: T
): string {
  return columns.map((c) => cell(row[c.key])).join(",") + "\r\n";
}
