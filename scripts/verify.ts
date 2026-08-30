#!/usr/bin/env tsx
/**
 * RecoLoop dataset verifier.
 *
 *   npx tsx scripts/verify.ts --seed 42 --defects 40
 *
 * Reads a generated dataset the same way a downstream consumer would - through
 * the CSVs, with normalisation - and asserts the structural invariants.
 * Exits non-zero if anything fails.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseArgs, renderTable } from "../src/lib/cli";
import { normaliseId, parseCsv } from "../src/lib/csv";
import { normaliseValueDate } from "../src/lib/dates"; 
import { parseIndianRupees } from "../src/lib/money";
import { DEFECT_CAUSES, type DefectCause, type DefectLabel } from "../src/lib/types";

/**
 * The verifier deliberately imports no business logic from the generator - only
 * parsing helpers. Every rate, constant and invariant below is restated from the
 * published contract in README.md, so a bug in the generator cannot hide inside
 * a shared helper that both sides call.
 */
const OPENING_BALANCE_PAISE = 25_000_000; // Rs 2,50,000
const PUBLISHED_FEE_BP: Readonly<Record<string, number>> = {
  upi: 0,
  card: 200,
  netbanking: 180,
  wallet: 220,
};
const GST_PERCENT = 18;
const DAY_MS = 86_400_000;

/** Restated independently: round-half-up, integer paise. */
const expectedFee = (amountPaise: number, method: string): number => {
  const bp = PUBLISHED_FEE_BP[method];
  if (bp === undefined) throw new Error(`unknown payment method: ${method}`);
  return Math.round((amountPaise * bp) / 10_000);
};
const expectedTax = (fee: number): number => Math.round((fee * GST_PERCENT) / 100);

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/** Columns whose value is a legitimate schema token that overlaps a cause name. */
const CAUSE_TOKEN_EXEMPT_COLUMNS = new Set(["settlement_status"]);

function intField(row: Record<string, string>, column: string): number {
  const raw = (row[column] ?? "").trim();
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`column ${column} is not an integer: ${JSON.stringify(row[column])}`);
  }
  return Number(raw);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2), { seed: 42, defects: 40, dir: "" });
  const seed = Math.trunc(args.seed);
  const dir = resolve(args.dir === "" ? `data/${seed}` : args.dir);

  const ordersText = readFileSync(join(dir, "orders.csv"), "utf8");
  const reportText = readFileSync(join(dir, "settlement_report.csv"), "utf8");
  const bankText = readFileSync(join(dir, "bank_statement.csv"), "utf8");
  const labels = JSON.parse(readFileSync(join(dir, "labels.json"), "utf8")) as DefectLabel[];

  const ordersCsv = parseCsv(ordersText);
  const reportCsv = parseCsv(reportText);
  const bankCsv = parseCsv(bankText);

  const checks: Check[] = [];
  const labelledIds = new Set(labels.map((l) => normaliseId(l.record_id)));

  // ------------------------------------------------ settlement net invariant
  interface Batch {
    id: string;
    utr: string;
    status: string;
    net: number;
    credit: number;
    debit: number;
    netValues: Set<number>;
    defective: boolean;
  }
  const batches = new Map<string, Batch>();
  for (const row of reportCsv.rows) {
    const id = normaliseId(row["settlement_id"] ?? "");
    let batch = batches.get(id);
    if (!batch) {
      batch = {
        id,
        utr: normaliseId(row["settlement_utr"] ?? ""),
        status: (row["settlement_status"] ?? "").trim(),
        net: intField(row, "settlement_net_amount_paise"),
        credit: 0,
        debit: 0,
        netValues: new Set<number>(),
        defective: labelledIds.has(id),
      };
      batches.set(id, batch);
    }
    batch.netValues.add(intField(row, "settlement_net_amount_paise"));
    batch.credit += intField(row, "credit_paise");
    batch.debit += intField(row, "debit_paise");
    for (const column of ["entity_id", "order_id", "payment_id"]) {
      const value = normaliseId(row[column] ?? "");
      if (value !== "" && labelledIds.has(value)) batch.defective = true;
    }
  }

  // No defect in the taxonomy perturbs this invariant - a settlement header is
  // always the exact arithmetic of its own lines, defective or not - so it is
  // asserted over the whole population rather than a clean subset.
  const netFailures: string[] = [];
  let defectiveBatches = 0;
  for (const batch of batches.values()) {
    if (batch.defective) defectiveBatches++;
    if (batch.netValues.size !== 1) {
      netFailures.push(`${batch.id}: net repeated inconsistently across its rows`);
      continue;
    }
    const computed = batch.credit - batch.debit;
    if (computed !== batch.net) {
      netFailures.push(`${batch.id}: lines net ${computed} != header ${batch.net}`);
    }
  }
  checks.push({
    name: "settlement net == sum(credit) - sum(debit)",
    pass: netFailures.length === 0,
    detail:
      netFailures.length === 0
        ? `${batches.size}/${batches.size} settlements balance exactly, incl. all ${defectiveBatches} carrying an injected defect`
        : netFailures.slice(0, 5).join("; "),
  });

  // ------------------------------------------------- one bank credit per batch
  interface BankRow {
    id: string;
    date: string;
    description: string;
    credit: number;
    debit: number;
    balance: number;
  }
  const bankRows: BankRow[] = bankCsv.rows.map((row) => ({
    id: normaliseId(row["bank_txn_id"] ?? ""),
    date: normaliseValueDate(row["value_date"] ?? ""),
    description: (row["description"] ?? "").trim(),
    credit: parseIndianRupees(row["credit"] ?? ""),
    debit: parseIndianRupees(row["debit"] ?? ""),
    balance: parseIndianRupees(row["running_balance"] ?? ""),
  }));

  const bankFailures: string[] = [];
  let processedMatched = 0;
  let heldSettlements = 0;
  for (const batch of batches.values()) {
    const matches = bankRows.filter((r) => r.description.includes(batch.utr));
    if (batch.status === "processed") {
      if (matches.length !== 1) {
        bankFailures.push(`${batch.id}: ${matches.length} bank credit(s) for UTR ${batch.utr}`);
        continue;
      }
      const only = matches[0] as BankRow;
      if (only.credit !== batch.net) {
        bankFailures.push(`${batch.id}: bank credit ${only.credit} != net ${batch.net}`);
        continue;
      }
      processedMatched++;
    } else {
      heldSettlements++;
      if (matches.length !== 0) {
        bankFailures.push(`${batch.id}: on_hold settlement has ${matches.length} bank credit(s)`);
      }
    }
  }
  checks.push({
    name: "processed settlement -> exactly one bank credit",
    pass: bankFailures.length === 0,
    detail:
      bankFailures.length === 0
        ? `${processedMatched} processed matched 1:1, ${heldSettlements} on_hold matched 0`
        : bankFailures.slice(0, 5).join("; "),
  });

  // ------------------------------------------------------- running balance
  let balance = OPENING_BALANCE_PAISE;
  const balanceFailures: string[] = [];
  for (const [index, row] of bankRows.entries()) {
    balance += row.credit - row.debit;
    if (row.balance !== balance) {
      balanceFailures.push(`row ${index + 2} (${row.id}): expected ${balance}, found ${row.balance}`);
    }
  }
  checks.push({
    name: "bank running balance is internally consistent",
    pass: balanceFailures.length === 0,
    detail:
      balanceFailures.length === 0
        ? `${bankRows.length} row(s) from opening ${OPENING_BALANCE_PAISE} paise to ${balance}`
        : balanceFailures.slice(0, 5).join("; "),
  });

  // ----------------------------------------------------------- label count
  const expected = Math.trunc(args.defects);
  checks.push({
    name: "labels.json count == requested defect count",
    pass: labels.length === expected,
    detail: `${labels.length} label(s), expected ${expected}`,
  });

  // -------------------------------------------------------- label integrity
  const orderIds = new Set(ordersCsv.rows.map((r) => normaliseId(r["order_id"] ?? "")));
  const entityIds = new Set(reportCsv.rows.map((r) => normaliseId(r["entity_id"] ?? "")));
  const settlementIds = new Set(batches.keys());
  const bankIds = new Set(bankRows.map((r) => r.id));
  const unresolved: string[] = [];
  for (const label of labels) {
    const id = normaliseId(label.record_id);
    const found =
      label.record_type === "order"
        ? orderIds.has(id)
        : label.record_type === "settlement"
          ? settlementIds.has(id)
          : label.record_type === "bank_txn"
            ? bankIds.has(id)
            : entityIds.has(id);
    if (!found) unresolved.push(`${label.true_cause} ${label.record_id} (${label.record_type})`);
  }
  const uniqueIds = new Set(labels.map((l) => `${l.record_type}:${normaliseId(l.record_id)}`));
  checks.push({
    name: "every label resolves to exactly one record",
    pass: unresolved.length === 0 && uniqueIds.size === labels.length,
    detail:
      unresolved.length > 0
        ? unresolved.slice(0, 5).join("; ")
        : uniqueIds.size !== labels.length
          ? "a record carries more than one defect"
          : `${labels.length} label(s) resolve; no record carries two defects`,
  });

  // -------------------------------------------------------------- leak scan
  const files: ReadonlyArray<readonly [string, ReturnType<typeof parseCsv>]> = [
    ["orders.csv", ordersCsv],
    ["settlement_report.csv", reportCsv],
    ["bank_statement.csv", bankCsv],
  ];
  const leaks: string[] = [];
  const notes = labels.map((l) => l.note).filter((n) => n.length > 0);
  for (const [name, csv] of files) {
    for (const header of csv.headers) {
      if (/true_?cause|defect|label|ground[_ ]?truth|anomal|injected/i.test(header)) {
        leaks.push(`${name}: header "${header}"`);
      }
    }
    for (const row of csv.rows) {
      for (const [column, value] of Object.entries(row)) {
        if (CAUSE_TOKEN_EXEMPT_COLUMNS.has(column)) continue;
        const upper = value.toUpperCase();
        for (const cause of DEFECT_CAUSES) {
          if (upper.includes(cause)) leaks.push(`${name}.${column}: contains "${cause}"`);
        }
      }
    }
  }
  for (const [name, text] of [
    ["orders.csv", ordersText],
    ["settlement_report.csv", reportText],
    ["bank_statement.csv", bankText],
  ] as const) {
    for (const note of notes) {
      if (text.includes(note)) leaks.push(`${name}: contains a label note verbatim`);
    }
  }
  checks.push({
    name: "no label data appears in any CSV",
    pass: leaks.length === 0,
    detail:
      leaks.length === 0
        ? `${DEFECT_CAUSES.length} cause token(s) and ${notes.length} note(s) absent from all 3 sources`
        : [...new Set(leaks)].slice(0, 5).join("; "),
  });

  // ------------------------------------------------------- no ordering tell
  const monotonic = (values: readonly string[]): number =>
    values.findIndex((v, i) => i > 0 && v < (values[i - 1] as string));
  const orderBreak = monotonic(ordersCsv.rows.map((r) => (r["created_at"] ?? "").trim()));
  const reportBreak = monotonic(reportCsv.rows.map((r) => (r["settled_at"] ?? "").trim()));
  const bankBreak = monotonic(bankRows.map((r) => r.date));
  const orderingIssues = [
    orderBreak >= 0 ? `orders.csv unsorted at row ${orderBreak + 2}` : "",
    reportBreak >= 0 ? `settlement_report.csv unsorted at row ${reportBreak + 2}` : "",
    bankBreak >= 0 ? `bank_statement.csv unsorted at row ${bankBreak + 2}` : "",
  ].filter((s) => s !== "");
  checks.push({
    name: "row order is chronological (no ordering tell)",
    pass: orderingIssues.length === 0,
    detail:
      orderingIssues.length === 0
        ? "all three sources sorted by their own timestamp column"
        : orderingIssues.join("; "),
  });

  // ----------------------------------------------------------- money is int
  const moneyIssues: string[] = [];
  const paiseColumns = [...ordersCsv.headers, ...reportCsv.headers].filter((h) =>
    h.endsWith("_paise"),
  );
  for (const [name, csv] of files) {
    for (const [index, row] of csv.rows.entries()) {
      for (const column of csv.headers) {
        if (!column.endsWith("_paise")) continue;
        const raw = (row[column] ?? "").trim();
        if (!/^-?\d+$/.test(raw)) moneyIssues.push(`${name} row ${index + 2}: ${column}=${raw}`);
      }
    }
  }
  for (const [index, row] of bankRows.entries()) {
    for (const value of [row.credit, row.debit, row.balance]) {
      if (!Number.isInteger(value)) moneyIssues.push(`bank_statement.csv row ${index + 2}`);
    }
  }
  checks.push({
    name: "every amount is an integer number of paise",
    pass: moneyIssues.length === 0,
    detail:
      moneyIssues.length === 0
        ? `${paiseColumns.length} paise column(s) + parsed bank amounts are all integral`
        : moneyIssues.slice(0, 5).join("; "),
  });

  // ---------------------------------- fee reconstruction from published slabs
  //
  // The invariant above is arithmetic internal to the report. This one rebuilds
  // each batch from gross amounts and the PUBLISHED fee slabs - the calculation
  // a merchant actually performs. FEE_VARIANCE is the only defect in the
  // taxonomy that perturbs it, and it must perturb it by exactly the injected
  // amount, so every settlement is covered: it either reconstructs exactly, or
  // it misses by precisely what its labels predict.
  const feeVarianceLabels = new Set(
    labels.filter((l) => l.true_cause === "FEE_VARIANCE").map((l) => normaliseId(l.record_id)),
  );
  const predictedDelta = new Map<string, number>();
  const reconstructedNet = new Map<string, number>();
  const deviatingLines = new Set<string>();

  for (const row of reportCsv.rows) {
    const settlementId = normaliseId(row["settlement_id"] ?? "");
    const type = (row["type"] ?? "").trim();
    let contribution: number;
    if (type === "payment") {
      const amount = intField(row, "amount_paise");
      const fee = expectedFee(amount, (row["method"] ?? "").trim());
      contribution = amount - fee - expectedTax(fee);
      const delta = intField(row, "fee_paise") + intField(row, "tax_paise") - fee - expectedTax(fee);
      if (delta !== 0) {
        deviatingLines.add(normaliseId(row["entity_id"] ?? ""));
        predictedDelta.set(settlementId, (predictedDelta.get(settlementId) ?? 0) + delta);
      }
    } else {
      contribution = -intField(row, "debit_paise");
    }
    reconstructedNet.set(settlementId, (reconstructedNet.get(settlementId) ?? 0) + contribution);
  }

  const reconFailures: string[] = [];
  for (const id of deviatingLines) {
    if (!feeVarianceLabels.has(id)) reconFailures.push(`${id}: fee is off-slab but carries no label`);
  }
  for (const id of feeVarianceLabels) {
    if (!deviatingLines.has(id)) reconFailures.push(`${id}: labelled FEE_VARIANCE but fee matches its slab`);
  }
  let exactBatches = 0;
  let deviatingBatches = 0;
  let totalDelta = 0;
  for (const batch of batches.values()) {
    const predicted = predictedDelta.get(batch.id) ?? 0;
    const observed = (reconstructedNet.get(batch.id) ?? 0) - batch.net;
    if (observed !== predicted) {
      reconFailures.push(
        `${batch.id}: reconstruction misses by ${observed}, labels predict ${predicted}`,
      );
      continue;
    }
    if (predicted === 0) exactBatches++;
    else {
      deviatingBatches++;
      totalDelta += predicted;
    }
  }
  checks.push({
    name: "net reconstructs from published fee slabs",
    pass: reconFailures.length === 0,
    detail:
      reconFailures.length === 0
        ? `${exactBatches} settlement(s) reconstruct exactly, ${deviatingBatches} deviate by exactly the injected delta (${totalDelta} paise total)`
        : reconFailures.slice(0, 5).join("; "),
  });

  // ------------------------------------------------- ground-truth conformance
  //
  // Every defect must actually manifest in the CSVs the way its taxonomy entry
  // says it does, and nothing else in the dataset may look like one. These
  // detectors read only the three sources - never labels.json - and their output
  // is then compared against the labels.
  interface OrderRow {
    id: string;
    amount: number;
    created: number;
    status: string;
  }
  const orderRows: OrderRow[] = ordersCsv.rows.map((row) => ({
    id: normaliseId(row["order_id"] ?? ""),
    amount: intField(row, "amount_paise"),
    created: Date.parse((row["created_at"] ?? "").trim()),
    status: (row["status"] ?? "").trim(),
  }));
  const orderIndex = new Map(orderRows.map((o) => [o.id, o]));
  const ordersByAmount = new Map<number, OrderRow[]>();
  for (const order of orderRows) {
    const bucket = ordersByAmount.get(order.amount);
    if (bucket) bucket.push(order);
    else ordersByAmount.set(order.amount, [order]);
  }

  const paymentRows = reportCsv.rows.filter((r) => (r["type"] ?? "").trim() === "payment");
  const settledPaymentIds = new Set(paymentRows.map((r) => normaliseId(r["payment_id"] ?? "")));
  const settledOrderIds = new Set(paymentRows.map((r) => normaliseId(r["order_id"] ?? "")));
  const allUtrs = new Set([...batches.values()].map((b) => b.utr));

  const detected = new Map<DefectCause, Set<string>>();
  const flag = (cause: DefectCause, id: string): void => {
    const existing = detected.get(cause);
    if (existing) existing.add(id);
    else detected.set(cause, new Set([id]));
  };
  for (const cause of DEFECT_CAUSES) detected.set(cause, new Set<string>());

  for (const row of paymentRows) {
    const entityId = normaliseId(row["entity_id"] ?? "");
    const order = orderIndex.get(normaliseId(row["order_id"] ?? ""));
    if (order !== undefined) {
      // Capture follows its order within half an hour, so a T+2 batch lands
      // inside ~2.3 days of order creation and a T+5 batch never does.
      const lag = Date.parse((row["settled_at"] ?? "").trim()) - order.created;
      if (lag > 3.5 * DAY_MS) flag("LATE_SETTLEMENT", entityId);
      if (intField(row, "amount_paise") < order.amount) flag("PARTIAL_CAPTURE", entityId);
      if (order.status === "pending") flag("SILENT_UPI_FAIL", order.id);
    }
  }
  for (const id of deviatingLines) flag("FEE_VARIANCE", id);
  for (const row of reportCsv.rows) {
    const type = (row["type"] ?? "").trim();
    const entityId = normaliseId(row["entity_id"] ?? "");
    if (type === "adjustment") flag("CHARGEBACK_DEBIT", entityId);
    if (type === "refund" && !settledPaymentIds.has(normaliseId(row["payment_id"] ?? ""))) {
      flag("REFUND_NETTED", entityId);
    }
  }
  for (const batch of batches.values()) {
    if (batch.status === "on_hold") flag("ON_HOLD", batch.id);
  }
  for (const row of bankRows) {
    if (![...allUtrs].some((u) => row.description.includes(u))) flag("UNEXPLAINED", row.id);
  }
  for (const order of orderRows) {
    if (order.status !== "paid" || settledOrderIds.has(order.id)) continue;
    const twins = ordersByAmount.get(order.amount) ?? [];
    if (twins.some((t) => t.id !== order.id && Math.abs(t.created - order.created) <= 90_000)) {
      flag("DUPLICATE_WEBHOOK", order.id);
    }
  }

  const truth = new Map<DefectCause, Set<string>>();
  for (const cause of DEFECT_CAUSES) truth.set(cause, new Set<string>());
  for (const label of labels) {
    (truth.get(label.true_cause) as Set<string>).add(normaliseId(label.record_id));
  }

  const conformanceRows: string[][] = [];
  const conformanceFailures: string[] = [];
  for (const cause of DEFECT_CAUSES) {
    const expectedSet = truth.get(cause) as Set<string>;
    const foundSet = detected.get(cause) as Set<string>;
    const missed = [...expectedSet].filter((id) => !foundSet.has(id));
    const extra = [...foundSet].filter((id) => !expectedSet.has(id));
    conformanceRows.push([
      cause,
      String(expectedSet.size),
      String(foundSet.size),
      `${expectedSet.size - missed.length}/${expectedSet.size}`,
      String(extra.length),
    ]);
    if (missed.length > 0) conformanceFailures.push(`${cause}: ${missed.length} label(s) do not manifest`);
    if (extra.length > 0) conformanceFailures.push(`${cause}: ${extra.length} unlabelled record(s) look defective`);
  }
  checks.push({
    name: "every defect manifests exactly as its taxonomy says",
    pass: conformanceFailures.length === 0,
    detail:
      conformanceFailures.length === 0
        ? `${labels.length}/${labels.length} labels recovered from the CSVs alone, 0 false positives`
        : conformanceFailures.slice(0, 5).join("; "),
  });

  // ------------------------------------------------------------------ report
  const rows = checks.map((c) => [c.pass ? "PASS" : "FAIL", c.name, c.detail]);
  console.log(`RecoLoop verify  ${dir}`);
  console.log("");
  console.log(renderTable(["result", "check", "detail"], rows));
  console.log("");
  console.log("Ground-truth conformance (detectors read the CSVs only)");
  console.log(
    renderTable(["cause", "labelled", "detected", "recall", "false pos"], conformanceRows),
  );
  console.log("");

  const failed = checks.filter((c) => !c.pass).length;
  if (failed > 0) {
    console.log(`${failed} of ${checks.length} checks FAILED`);
    process.exit(1);
  }
  console.log(`all ${checks.length} checks passed`);
}

try {
  main();
} catch (error) {
  console.error(`recoloop: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
