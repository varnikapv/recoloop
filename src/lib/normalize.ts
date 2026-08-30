/**
 * Stage 0 — normalisation.
 *
 * The consumer-side cleanup of the three raw sources. This module deliberately
 * imports no generator business logic: every rule below is implemented against
 * the documented file contract, so a generator bug cannot hide in a helper both
 * sides call.
 *
 * Nothing here guesses. A value that does not match a known shape throws with
 * the raw text attached.
 */
import { parseCsv } from "./csv";

// ----------------------------------------------------------------- primitives

/** IDs arrive with stray whitespace and mixed case ~8% of the time. */
export function normalizeId(raw: string): string {
  return raw.trim().toLowerCase();
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLASH_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** Accepts "DD/MM/YYYY" and "YYYY-MM-DD". Emits ISO "YYYY-MM-DD". */
export function normalizeDate(raw: string): string {
  const text = raw.trim();
  const slash = SLASH_DATE.exec(text);
  if (slash) return `${slash[3]}-${slash[2]}-${slash[1]}`;
  if (ISO_DATE.test(text)) return text;
  throw new Error(`unrecognised date format: ${JSON.stringify(raw)}`);
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function normalizeTimestamp(raw: string): string {
  const text = raw.trim();
  if (!ISO_TIMESTAMP.test(text)) {
    throw new Error(`unrecognised timestamp: ${JSON.stringify(raw)}`);
  }
  return text;
}

/**
 * Amounts arrive two ways: bare integer paise in the gateway files, and Indian
 * grouped rupee strings ("1,24,530.00") in the bank statement.
 *
 * Parsed as a STRING into paise — never parseFloat-then-round, which would put
 * a binary float between the file and the ledger.
 */
export function parsePaise(raw: string): number {
  const text = raw.trim();
  if (text === "") return 0;
  const negative = text.startsWith("-");
  const body = (negative ? text.slice(1) : text).replace(/,/g, "");
  if (!/^\d+(\.\d*)?$/.test(body)) {
    throw new Error(`unparseable amount: ${JSON.stringify(raw)}`);
  }
  const dot = body.indexOf(".");
  const whole = dot === -1 ? body : body.slice(0, dot);
  const fraction = dot === -1 ? "" : body.slice(dot + 1);
  const paise = Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
  return negative ? -paise : paise;
}

/** Columns already denominated in paise must be bare integers. */
export function parseIntegerPaise(raw: string): number {
  const text = raw.trim();
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`expected integer paise, got ${JSON.stringify(raw)}`);
  }
  return Number(text);
}

/** The three statement description shapes emit.ts produces. */
export const DESCRIPTION_FORMATS: ReadonlyArray<readonly [string, RegExp]> = [
  ["RAZORPAY_SETTLEMENT", /^RAZORPAY SETTLEMENT (\d{12})$/],
  ["NEFT_CR", /^NEFT CR-(\d{12})-RAZORPAY SOFTWARE PVT LTD$/],
  ["IMPS", /^IMPS\/(\d{12})\/RAZORPAYSOFT$/],
];

/** A 12-digit run not glued to further digits. */
const UTR_ANYWHERE = /(?<!\d)(\d{12})(?!\d)/;

export interface UtrExtraction {
  utr: string;
  /** Which known template matched, or "UNKNOWN_FORMAT" if only the loose scan hit. */
  format: string;
}

export function extractUtr(description: string): UtrExtraction {
  const text = description.trim();
  for (const [name, pattern] of DESCRIPTION_FORMATS) {
    const hit = pattern.exec(text);
    if (hit) return { utr: hit[1] as string, format: name };
  }
  const loose = UTR_ANYWHERE.exec(text);
  if (loose) return { utr: loose[1] as string, format: "UNKNOWN_FORMAT" };
  throw new Error(`no 12-digit UTR in bank description: ${JSON.stringify(description)}`);
}

// -------------------------------------------------------------- record shapes

export type LineType = "payment" | "refund" | "adjustment";
export type SettlementStatus = "processed" | "on_hold";

export interface NormalizedOrder {
  order_id: string;
  amount_paise: number;
  currency: string;
  created_at: string;
  created_ms: number;
  status: string;
  raw: Record<string, string>;
}

export interface NormalizedLine {
  entity_id: string;
  type: LineType;
  order_id: string | null;
  payment_id: string | null;
  method: string | null;
  currency: string | null;
  debit_paise: number;
  credit_paise: number;
  amount_paise: number;
  fee_paise: number;
  tax_paise: number;
  settlement_id: string;
  settled_at: string;
  settled_ms: number;
  settlement_utr: string;
  settlement_status: SettlementStatus;
  settlement_net_amount_paise: number;
  settlement_fee_paise: number;
  settlement_tax_paise: number;
  settlement_created_at: string;
  raw: Record<string, string>;
}

export interface NormalizedBankTxn {
  bank_txn_id: string;
  value_date: string;
  description: string;
  utr: string;
  description_format: string;
  credit_paise: number;
  debit_paise: number;
  running_balance_paise: number;
  raw: Record<string, string>;
}

export interface CorrectionSample {
  field: string;
  raw: string;
  normalized: string;
}

export interface NormalizeLog {
  corrections_by_field: Record<string, number>;
  total_corrections: number;
  rows_by_file: Record<string, number>;
  samples: CorrectionSample[];
}

export interface NormalizedDataset {
  orders: NormalizedOrder[];
  lines: NormalizedLine[];
  bank: NormalizedBankTxn[];
  log: NormalizeLog;
}

const MAX_SAMPLES_PER_FIELD = 3;

class Auditor {
  readonly counts = new Map<string, number>();
  readonly samples: CorrectionSample[] = [];
  private readonly sampled = new Map<string, number>();

  record(field: string, raw: string, normalized: string): void {
    this.counts.set(field, (this.counts.get(field) ?? 0) + 1);
    const taken = this.sampled.get(field) ?? 0;
    if (taken < MAX_SAMPLES_PER_FIELD) {
      this.sampled.set(field, taken + 1);
      this.samples.push({ field, raw, normalized });
    }
  }

  /** Normalise an id, recording it only when the raw text actually differed. */
  id(field: string, raw: string): string {
    const clean = normalizeId(raw);
    if (clean !== raw) this.record(field, raw, clean);
    return clean;
  }
}

function requireLineType(raw: string): LineType {
  const value = raw.trim();
  if (value === "payment" || value === "refund" || value === "adjustment") return value;
  throw new Error(`unrecognised settlement line type: ${JSON.stringify(raw)}`);
}

function requireSettlementStatus(raw: string): SettlementStatus {
  const value = raw.trim();
  if (value === "processed" || value === "on_hold") return value;
  throw new Error(`unrecognised settlement status: ${JSON.stringify(raw)}`);
}

function optionalId(auditor: Auditor, field: string, raw: string): string | null {
  if (raw.trim() === "") return null;
  return auditor.id(field, raw);
}

export function normalizeDataset(sources: {
  ordersCsv: string;
  settlementReportCsv: string;
  bankStatementCsv: string;
}): NormalizedDataset {
  const auditor = new Auditor();

  const ordersCsv = parseCsv(sources.ordersCsv);
  const orders: NormalizedOrder[] = ordersCsv.rows.map((row) => {
    const createdRaw = row["created_at"] ?? "";
    const created = normalizeTimestamp(createdRaw);
    return {
      order_id: auditor.id("orders.order_id", row["order_id"] ?? ""),
      amount_paise: parseIntegerPaise(row["amount_paise"] ?? ""),
      currency: (row["currency"] ?? "").trim(),
      created_at: created,
      created_ms: Date.parse(created),
      status: (row["status"] ?? "").trim(),
      raw: row,
    };
  });

  const reportCsv = parseCsv(sources.settlementReportCsv);
  const lines: NormalizedLine[] = reportCsv.rows.map((row) => {
    const settledAt = normalizeTimestamp(row["settled_at"] ?? "");
    const methodRaw = (row["method"] ?? "").trim();
    const currencyRaw = (row["currency"] ?? "").trim();
    return {
      entity_id: auditor.id("settlement_report.entity_id", row["entity_id"] ?? ""),
      type: requireLineType(row["type"] ?? ""),
      order_id: optionalId(auditor, "settlement_report.order_id", row["order_id"] ?? ""),
      payment_id: optionalId(auditor, "settlement_report.payment_id", row["payment_id"] ?? ""),
      method: methodRaw === "" ? null : methodRaw,
      currency: currencyRaw === "" ? null : currencyRaw,
      debit_paise: parseIntegerPaise(row["debit_paise"] ?? ""),
      credit_paise: parseIntegerPaise(row["credit_paise"] ?? ""),
      amount_paise: parseIntegerPaise(row["amount_paise"] ?? ""),
      fee_paise: parseIntegerPaise(row["fee_paise"] ?? ""),
      tax_paise: parseIntegerPaise(row["tax_paise"] ?? ""),
      settlement_id: auditor.id("settlement_report.settlement_id", row["settlement_id"] ?? ""),
      settled_at: settledAt,
      settled_ms: Date.parse(settledAt),
      settlement_utr: auditor.id("settlement_report.settlement_utr", row["settlement_utr"] ?? ""),
      settlement_status: requireSettlementStatus(row["settlement_status"] ?? ""),
      settlement_net_amount_paise: parseIntegerPaise(row["settlement_net_amount_paise"] ?? ""),
      settlement_fee_paise: parseIntegerPaise(row["settlement_fee_paise"] ?? ""),
      settlement_tax_paise: parseIntegerPaise(row["settlement_tax_paise"] ?? ""),
      settlement_created_at: normalizeTimestamp(row["settlement_created_at"] ?? ""),
      raw: row,
    };
  });

  const bankCsv = parseCsv(sources.bankStatementCsv);
  const bank: NormalizedBankTxn[] = bankCsv.rows.map((row) => {
    const rawDate = row["value_date"] ?? "";
    const valueDate = normalizeDate(rawDate);
    if (valueDate !== rawDate.trim() || rawDate !== rawDate.trim()) {
      auditor.record("bank_statement.value_date", rawDate, valueDate);
    }
    const description = (row["description"] ?? "").trim();
    const { utr, format } = extractUtr(description);
    // The UTR is only ever available as a substring of free text, so every row
    // is a derivation worth auditing.
    auditor.record(`bank_statement.description[${format}]`, description, utr);

    const creditRaw = row["credit"] ?? "";
    const debitRaw = row["debit"] ?? "";
    const balanceRaw = row["running_balance"] ?? "";
    const credit = parsePaise(creditRaw);
    const debit = parsePaise(debitRaw);
    const balance = parsePaise(balanceRaw);
    for (const [field, raw, value] of [
      ["bank_statement.credit", creditRaw, credit],
      ["bank_statement.debit", debitRaw, debit],
      ["bank_statement.running_balance", balanceRaw, balance],
    ] as const) {
      if (raw.includes(",") || raw.includes(".")) auditor.record(field, raw, String(value));
    }

    return {
      bank_txn_id: auditor.id("bank_statement.bank_txn_id", row["bank_txn_id"] ?? ""),
      value_date: valueDate,
      description,
      utr,
      description_format: format,
      credit_paise: credit,
      debit_paise: debit,
      running_balance_paise: balance,
      raw: row,
    };
  });

  const correctionsByField: Record<string, number> = {};
  for (const field of [...auditor.counts.keys()].sort()) {
    correctionsByField[field] = auditor.counts.get(field) ?? 0;
  }

  return {
    orders,
    lines,
    bank,
    log: {
      corrections_by_field: correctionsByField,
      total_corrections: [...auditor.counts.values()].reduce((sum, n) => sum + n, 0),
      rows_by_file: {
        "orders.csv": orders.length,
        "settlement_report.csv": lines.length,
        "bank_statement.csv": bank.length,
      },
      samples: auditor.samples,
    },
  };
}
