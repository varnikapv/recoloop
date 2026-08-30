/**
 * Orchestration for the four matcher stages, plus all file I/O.
 *
 * The stages themselves are pure. This module reads the three CSVs, runs them,
 * asserts the partition, and writes match_result.json + normalize_log.json.
 *
 * It never reads labels.json, and nothing in its import graph does either —
 * scripts/checkIsolation.ts enforces that as a build step.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type NormalizedDataset, normalizeDataset } from "../normalize";
import { checkSettlementDelay } from "./delay";
import { matchOrdersToPayments } from "./orderPayment";
import { matchLinesToEntities } from "./paymentSettlement";
import { matchSettlementsToBank } from "./settlementBank";
import { buildResidue, residueValuePaise } from "./residue";
import {
  type EntityKind,
  type Finding,
  type MatchResult,
  type MatchedRecord,
  type ResidueEntry,
  entityKey,
} from "./types";

export interface ComputeOutput extends MatchResult {
  findings: Finding[];
  day_delta_histogram: Record<string, number>;
}

/** Pure: normalized records in, full match result out. */
export function computeMatch(dataset: NormalizedDataset): ComputeOutput {
  const { orders, lines, bank } = dataset;

  const stage1 = matchOrdersToPayments(orders, lines);
  const stage2 = matchLinesToEntities(orders, lines);
  const stage3 = matchSettlementsToBank(lines, bank);
  const stage4 = checkSettlementDelay(orders, lines);

  const findings: Finding[] = [
    ...stage1.findings,
    ...stage2.findings,
    ...stage3.findings,
    ...stage4.findings,
  ];

  const owned = new Set<string>();
  for (const finding of findings) {
    for (const entity of finding.entities) owned.add(entityKey(entity.kind, entity.id));
  }
  const isOwned = (kind: EntityKind, id: string): boolean => owned.has(entityKey(kind, id));

  // A line reconciles only if it is itself clean AND its settlement reached the
  // bank. Everything else is already owned by some finding.
  const matched: MatchedRecord[] = [];
  for (const line of lines) {
    if (isOwned("settlement_line", line.entity_id)) continue;
    if (!stage3.matchedSettlementIds.has(line.settlement_id)) continue;
    const bankRow = stage3.bankBySettlement.get(line.settlement_id);
    if (bankRow === undefined) continue;
    // An order is reconciled by its own payment, never by a refund raised
    // against it — so a refund line still reconciles when its parent order is
    // in residue for an unrelated reason.
    if (line.type === "payment" && line.order_id !== null && isOwned("order", line.order_id)) {
      continue;
    }
    const group = stage3.groups.find((g) => g.settlement_id === line.settlement_id);
    matched.push({
      order_id: line.order_id,
      payment_id: line.type === "payment" ? line.entity_id : line.payment_id,
      line_id: line.entity_id,
      line_type: line.type,
      settlement_id: line.settlement_id,
      bank_txn_id: bankRow.bank_txn_id,
      net_paise: group?.expected_net_paise ?? 0,
      verified: true,
    });
  }
  matched.sort((a, b) =>
    a.settlement_id === b.settlement_id
      ? a.line_id.localeCompare(b.line_id)
      : a.settlement_id.localeCompare(b.settlement_id),
  );

  const reconciledSettlements = [...stage3.matchedSettlementIds].sort();
  const reconciledBankTxns = [...stage3.matchedBankIds].sort();

  const residue = buildResidue({ findings, orders, lines, bank });

  const findingTypeCounts: Record<string, number> = {};
  for (const finding of findings) {
    findingTypeCounts[finding.code] = (findingTypeCounts[finding.code] ?? 0) + 1;
  }
  const orderedCounts: Record<string, number> = {};
  for (const key of Object.keys(findingTypeCounts).sort()) {
    orderedCounts[key] = findingTypeCounts[key] as number;
  }

  const matchedValue = matched.reduce((sum, m) => {
    const line = lines.find((l) => l.entity_id === m.line_id);
    return sum + (line?.amount_paise ?? 0);
  }, 0);
  const residueValue = residue.reduce((sum, entry) => sum + residueValuePaise(entry), 0);
  const denominatorCount = matched.length + residue.length;
  const denominatorValue = matchedValue + residueValue;

  return {
    matched,
    residue,
    excluded: [...stage1.excluded].sort((a, b) => a.order_id.localeCompare(b.order_id)),
    reconciled_settlements: reconciledSettlements,
    reconciled_bank_txns: reconciledBankTxns,
    findings,
    day_delta_histogram: stage4.histogram,
    metrics: {
      total_orders: orders.length,
      total_payments: lines.filter((l) => l.type === "payment").length,
      total_refunds: lines.filter((l) => l.type === "refund").length,
      total_adjustments: lines.filter((l) => l.type === "adjustment").length,
      total_settlements: stage3.groups.length,
      total_bank_rows: bank.length,
      auto_matched_count: matched.length,
      auto_matched_value_paise: matchedValue,
      residue_count: residue.length,
      residue_value_paise: residueValue,
      excluded_count: stage1.excluded.length,
      match_rate_by_count:
        denominatorCount === 0 ? 1 : Math.round((matched.length / denominatorCount) * 10_000) / 10_000,
      match_rate_by_value:
        denominatorValue === 0 ? 1 : Math.round((matchedValue / denominatorValue) * 10_000) / 10_000,
      finding_type_counts: orderedCounts,
    },
  };
}

/**
 * Every entity in the three sources must land in exactly one of: a matched
 * record, a residue entry, or the excluded list. Nothing is ever silently
 * dropped, and nothing is ever counted twice.
 */
export function assertNothingDropped(
  dataset: NormalizedDataset,
  result: ComputeOutput,
): void {
  const universe: Record<EntityKind, Set<string>> = {
    order: new Set(dataset.orders.map((o) => o.order_id)),
    settlement_line: new Set(dataset.lines.map((l) => l.entity_id)),
    settlement: new Set(dataset.lines.map((l) => l.settlement_id)),
    bank_txn: new Set(dataset.bank.map((b) => b.bank_txn_id)),
  };

  const inMatched: Record<EntityKind, Set<string>> = {
    order: new Set(),
    settlement_line: new Set(),
    settlement: new Set(),
    bank_txn: new Set(),
  };
  for (const record of result.matched) {
    // Ownership rule: only a payment line's matched record claims its order.
    if (record.line_type === "payment" && record.order_id !== null) {
      inMatched.order.add(record.order_id);
    }
    inMatched.settlement_line.add(record.line_id);
  }
  // A batch that reconciled against its bank credit is matched even when every
  // one of its individual lines is separately disputed.
  for (const id of result.reconciled_settlements) inMatched.settlement.add(id);
  for (const id of result.reconciled_bank_txns) inMatched.bank_txn.add(id);

  const inResidue: Record<EntityKind, Set<string>> = {
    order: new Set(),
    settlement_line: new Set(),
    settlement: new Set(),
    bank_txn: new Set(),
  };
  const residueOwner = new Map<string, string>();
  for (const entry of result.residue) {
    const buckets: ReadonlyArray<readonly [EntityKind, ResidueEntry["entities"]["orders"]]> = [
      ["order", entry.entities.orders],
      ["settlement_line", entry.entities.settlement_lines],
      ["settlement", entry.entities.settlements],
      ["bank_txn", entry.entities.bank_txns],
    ];
    for (const [kind, list] of buckets) {
      for (const item of list ?? []) {
        const key = entityKey(kind, item.id);
        const previous = residueOwner.get(key);
        if (previous !== undefined) {
          throw new Error(
            `${key} appears in two residue entries (${previous} and ${entry.residue_id})`,
          );
        }
        residueOwner.set(key, entry.residue_id);
        inResidue[kind].add(item.id);
      }
    }
  }

  const inExcluded = new Set(result.excluded.map((e) => e.order_id));
  const problems: string[] = [];

  for (const kind of Object.keys(universe) as EntityKind[]) {
    for (const id of universe[kind]) {
      const buckets = [
        inMatched[kind].has(id) ? "matched" : "",
        inResidue[kind].has(id) ? "residue" : "",
        kind === "order" && inExcluded.has(id) ? "excluded" : "",
      ].filter((b) => b !== "");
      if (buckets.length === 0) problems.push(`${kind} ${id}: unaccounted for`);
      if (buckets.length > 1) problems.push(`${kind} ${id}: appears in ${buckets.join(" and ")}`);
    }
    for (const id of inMatched[kind]) {
      if (!universe[kind].has(id)) problems.push(`${kind} ${id}: matched but not in the input`);
    }
    for (const id of inResidue[kind]) {
      if (!universe[kind].has(id)) problems.push(`${kind} ${id}: in residue but not in the input`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `entity accounting failed (${problems.length} problem(s)):\n  ${problems.slice(0, 10).join("\n  ")}`,
    );
  }
}

export interface RunOutput {
  dataset: NormalizedDataset;
  result: ComputeOutput;
  files: { matchResult: string; normalizeLog: string };
}

export function runMatch(dir: string): RunOutput {
  const dataset = normalizeDataset({
    ordersCsv: readFileSync(join(dir, "orders.csv"), "utf8"),
    settlementReportCsv: readFileSync(join(dir, "settlement_report.csv"), "utf8"),
    bankStatementCsv: readFileSync(join(dir, "bank_statement.csv"), "utf8"),
  });

  const result = computeMatch(dataset);
  assertNothingDropped(dataset, result);

  const files = {
    matchResult: join(dir, "match_result.json"),
    normalizeLog: join(dir, "normalize_log.json"),
  };
  const { findings: _findings, ...serialisable } = result;
  writeFileSync(files.matchResult, `${JSON.stringify(serialisable, null, 2)}\n`, "utf8");
  writeFileSync(files.normalizeLog, `${JSON.stringify(dataset.log, null, 2)}\n`, "utf8");
  return { dataset, result, files };
}
