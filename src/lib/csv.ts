/** RFC4180-ish CSV writer/reader shared by the generator and the verifier. */

export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value) || /^\s/.test(value) || /\s$/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toCsv(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const lines: string[] = [headers.map(csvEscape).join(",")];
  for (const row of rows) lines.push(row.map(csvEscape).join(","));
  return `${lines.join("\n")}\n`;
}

export interface ParsedCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

function parseRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let started = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      started = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
      started = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (started || field.length > 0 || record.length > 0) {
        record.push(field);
        records.push(record);
      }
      field = "";
      record = [];
      started = false;
    } else {
      field += ch;
      started = true;
    }
  }
  if (started || field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

export function parseCsv(text: string): ParsedCsv {
  const records = parseRecords(text);
  const headerRecord = records.shift();
  if (!headerRecord) throw new Error("empty CSV");
  const headers = headerRecord.map((h) => h.trim());
  const rows = records.map((record) => {
    const row: Record<string, string> = {};
    headers.forEach((header, idx) => {
      row[header] = record[idx] ?? "";
    });
    return row;
  });
  return { headers, rows };
}

/** The normalisation any downstream consumer has to do: trim + lowercase. */
export function normaliseId(raw: string): string {
  return raw.trim().toLowerCase();
}
