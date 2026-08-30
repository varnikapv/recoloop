import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { toIsoDate, toSlashDate } from "./dates";
import { toCsv } from "./csv";
import { dirtyId } from "./ids";
import { formatIndianRupees } from "./money";
import { mulberry32 } from "./rng";
import type { Dataset } from "./types";

export const ORDERS_HEADERS = [
  "order_id",
  "amount_paise",
  "currency",
  "created_at",
  "status",
] as const;

export const SETTLEMENT_HEADERS = [
  "entity_id",
  "type",
  "order_id",
  "payment_id",
  "method",
  "currency",
  "debit_paise",
  "credit_paise",
  "amount_paise",
  "fee_paise",
  "tax_paise",
  "settlement_id",
  "settled_at",
  "settlement_utr",
  "settlement_status",
  "settlement_net_amount_paise",
  "settlement_fee_paise",
  "settlement_tax_paise",
  "settlement_created_at",
] as const;

export const BANK_HEADERS = [
  "bank_txn_id",
  "value_date",
  "description",
  "credit",
  "debit",
  "running_balance",
] as const;

/**
 * Dirt is drawn from its own stream, derived from the dataset seed, so adding
 * or removing dirt never shifts the generation stream.
 */
function dirtRng(seed: number) {
  return mulberry32((seed ^ 0x9e3779b9) >>> 0);
}

export function renderOrdersCsv(dataset: Dataset, seed: number): string {
  const rng = dirtRng(seed);
  const rows = dataset.orders.map((order) => [
    dirtyId(rng, order.order_id),
    String(order.amount_paise),
    order.currency,
    order.created_at,
    order.status,
  ]);
  return toCsv(ORDERS_HEADERS, rows);
}

export function renderSettlementReportCsv(dataset: Dataset, seed: number): string {
  const rng = dirtRng(seed + 1);
  const byId = new Map(dataset.settlements.map((s) => [s.settlement_id, s]));
  const rows = dataset.lines.map((line) => {
    const settlement = byId.get(line.settlement_id);
    if (!settlement) throw new Error(`orphan line ${line.entity_id}`);
    return [
      dirtyId(rng, line.entity_id),
      line.type,
      line.order_id === null ? "" : dirtyId(rng, line.order_id),
      line.payment_id === null ? "" : dirtyId(rng, line.payment_id),
      line.method ?? "",
      line.type === "adjustment" ? "" : "INR",
      String(line.debit_paise),
      String(line.credit_paise),
      String(line.amount_paise),
      String(line.fee_paise),
      String(line.tax_paise),
      dirtyId(rng, line.settlement_id),
      line.settled_at,
      dirtyId(rng, settlement.utr),
      settlement.status,
      String(settlement.net_amount_paise),
      String(settlement.fee_paise),
      String(settlement.tax_paise),
      settlement.created_at,
    ];
  });
  return toCsv(SETTLEMENT_HEADERS, rows);
}

export function renderBankStatementCsv(dataset: Dataset, seed: number): string {
  const rng = dirtRng(seed + 2);
  const rows = dataset.bank.map((txn, index) => {
    const dayMs = Date.parse(`${txn.value_date}T00:00:00Z`);
    // Statement exports alternate between the two date formats, row by row.
    const valueDate = index % 2 === 0 ? toSlashDate(dayMs) : toIsoDate(dayMs);
    return [
      dirtyId(rng, txn.bank_txn_id),
      valueDate,
      txn.description,
      txn.credit_paise === 0 ? "" : formatIndianRupees(txn.credit_paise),
      txn.debit_paise === 0 ? "" : formatIndianRupees(txn.debit_paise),
      formatIndianRupees(txn.running_balance_paise),
    ];
  });
  return toCsv(BANK_HEADERS, rows);
}

export interface WrittenFiles {
  dir: string;
  orders: string;
  settlementReport: string;
  bankStatement: string;
  labels: string;
}

export function writeDataset(dataset: Dataset, seed: number, outDir: string): WrittenFiles {
  mkdirSync(outDir, { recursive: true });
  const files: WrittenFiles = {
    dir: outDir,
    orders: join(outDir, "orders.csv"),
    settlementReport: join(outDir, "settlement_report.csv"),
    bankStatement: join(outDir, "bank_statement.csv"),
    labels: join(outDir, "labels.json"),
  };
  writeFileSync(files.orders, renderOrdersCsv(dataset, seed), "utf8");
  writeFileSync(files.settlementReport, renderSettlementReportCsv(dataset, seed), "utf8");
  writeFileSync(files.bankStatement, renderBankStatementCsv(dataset, seed), "utf8");
  writeFileSync(files.labels, `${JSON.stringify(dataset.labels, null, 2)}\n`, "utf8");
  return files;
}
