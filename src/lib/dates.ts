/** All timestamps are UTC. Settlements land at 05:30 UTC (11:00 IST). */

export const DAY_MS = 86_400_000;
export const SETTLEMENT_TIME_MS = 5 * 3_600_000 + 30 * 60_000;

/** ISO-8601 with second precision: 2025-01-01T05:30:00Z */
export function toIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function fromIso(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`bad ISO timestamp: ${iso}`);
  return ms;
}

export function dayStartUtc(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export function addDays(ms: number, days: number): number {
  return ms + days * DAY_MS;
}

/** YYYY-MM-DD */
export function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** DD/MM/YYYY */
export function toSlashDate(ms: number): string {
  const d = new Date(ms);
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

/** Accepts either statement format and normalises to YYYY-MM-DD. */
export function normaliseValueDate(raw: string): string {
  const text = raw.trim();
  const slash = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (slash) return `${slash[3]}-${slash[2]}-${slash[1]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  throw new Error(`unrecognised value_date: ${JSON.stringify(raw)}`);
}
