#!/usr/bin/env tsx
/**
 * Scores match_result.json against ground truth.
 *
 * This is the ONLY script in the matcher pipeline permitted to read
 * labels.json, and it does so through src/lib/labels.ts — the single loader
 * that scripts/checkIsolation.ts keeps out of the matcher's import graph.
 *
 *   npx tsx scripts/scoreMatch.ts --seed 42
 *
 * Exits non-zero unless every labelled defect reached residue.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseArgs, renderTable } from "../src/lib/cli";
import { loadLabels } from "../src/lib/labels";
import { normalizeId } from "../src/lib/normalize";
import type { MatchResult, ResidueEntry } from "../src/lib/match/types";

const UNLABELLED = "(unlabelled)";

function entityIds(entry: ResidueEntry): string[] {
  return [
    ...(entry.entities.orders ?? []),
    ...(entry.entities.settlement_lines ?? []),
    ...(entry.entities.settlements ?? []),
    ...(entry.entities.bank_txns ?? []),
  ].map((e) => normalizeId(e.id));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2), { seed: 42, dir: "" });
  const seed = Math.trunc(args.seed);
  const dir = resolve(args.dir === "" ? `data/${seed}` : args.dir);

  const labels = loadLabels(dir);
  const result = JSON.parse(
    readFileSync(join(dir, "match_result.json"), "utf8"),
  ) as MatchResult;

  const causeById = new Map(labels.map((l) => [normalizeId(l.record_id), l.true_cause]));

  // Where did every id end up?
  const residueById = new Map<string, ResidueEntry>();
  for (const entry of result.residue) {
    for (const id of entityIds(entry)) residueById.set(id, entry);
  }
  // Mirrors the ownership rule the matcher's partition assertion uses.
  const matchedIds = new Set<string>();
  for (const record of result.matched) {
    if (record.line_type === "payment" && record.order_id !== null) {
      matchedIds.add(normalizeId(record.order_id));
    }
    matchedIds.add(normalizeId(record.line_id));
  }
  for (const id of result.reconciled_settlements) matchedIds.add(normalizeId(id));
  for (const id of result.reconciled_bank_txns) matchedIds.add(normalizeId(id));
  const excludedIds = new Set(result.excluded.map((e) => normalizeId(e.order_id)));

  // ------------------------------------------------------- defect capture
  const captured: string[] = [];
  const falselyMatched: string[] = [];
  const droppedToExcluded: string[] = [];
  const unaccounted: string[] = [];

  for (const label of labels) {
    const id = normalizeId(label.record_id);
    if (residueById.has(id)) {
      captured.push(id);
      continue;
    }
    if (matchedIds.has(id)) falselyMatched.push(`${label.true_cause} ${label.record_id}`);
    else if (excludedIds.has(id)) droppedToExcluded.push(`${label.true_cause} ${label.record_id}`);
    else unaccounted.push(`${label.true_cause} ${label.record_id}`);
  }

  console.log(`RecoLoop score  ${dir}`);
  console.log("");
  console.log(
    `DEFECT CAPTURE RATE: ${captured.length}/${labels.length}` +
      (captured.length === labels.length ? "  — every labelled defect reached residue" : ""),
  );
  if (falselyMatched.length > 0) {
    console.log("");
    console.log("!!! DEFECTS SILENTLY AUTO-MATCHED AS CLEAN — these never reach the classifier:");
    for (const item of falselyMatched) console.log(`      ${item}`);
  }
  if (droppedToExcluded.length > 0) {
    console.log("");
    console.log("!!! DEFECTS DROPPED INTO THE EXCLUDED BUCKET:");
    for (const item of droppedToExcluded) console.log(`      ${item}`);
  }
  if (unaccounted.length > 0) {
    console.log("");
    console.log("!!! DEFECTS NOT FOUND ANYWHERE IN THE MATCH RESULT:");
    for (const item of unaccounted) console.log(`      ${item}`);
  }

  // -------------------------------------------- per-cause capture breakdown
  const byCause = new Map<string, { total: number; captured: number }>();
  for (const label of labels) {
    const entry = byCause.get(label.true_cause) ?? { total: 0, captured: 0 };
    entry.total++;
    if (residueById.has(normalizeId(label.record_id))) entry.captured++;
    byCause.set(label.true_cause, entry);
  }
  console.log("");
  console.log("Capture by true cause");
  console.log(
    renderTable(
      ["true_cause", "labelled", "in residue", "captured"],
      [...byCause.entries()]
        .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
        .map(([cause, stat]) => [
          cause,
          String(stat.total),
          String(stat.captured),
          stat.captured === stat.total ? "yes" : `NO (${stat.total - stat.captured} missed)`,
        ]),
    ),
  );

  // ------------------------------------------ clean-record auto-match rate
  const labelledIds = new Set(causeById.keys());
  let cleanMatched = 0;
  let cleanResidue = 0;
  const seen = new Set<string>();
  for (const id of matchedIds) {
    if (labelledIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    cleanMatched++;
  }
  for (const entry of result.residue) {
    for (const id of entityIds(entry)) {
      if (labelledIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      cleanResidue++;
    }
  }
  const cleanTotal = cleanMatched + cleanResidue;

  // --------------------------------------------------- residue precision
  let entriesWithDefect = 0;
  for (const entry of result.residue) {
    if (entityIds(entry).some((id) => labelledIds.has(id))) entriesWithDefect++;
  }

  console.log("");
  console.log("Match quality on the non-defective majority");
  console.log(
    renderTable(
      ["measure", "value"],
      [
        ["clean records auto-matched", `${cleanMatched}/${cleanTotal}`],
        [
          "clean auto-match rate",
          cleanTotal === 0 ? "n/a" : `${((cleanMatched / cleanTotal) * 100).toFixed(2)}%`,
        ],
        ["clean records pulled into residue", String(cleanResidue)],
        ["residue entries", String(result.residue.length)],
        [
          "residue entries containing a real defect",
          `${entriesWithDefect}/${result.residue.length}` +
            (result.residue.length === 0
              ? ""
              : ` (${((entriesWithDefect / result.residue.length) * 100).toFixed(1)}%)`),
        ],
        ["overall match rate by count", `${(result.metrics.match_rate_by_count * 100).toFixed(2)}%`],
        ["overall match rate by value", `${(result.metrics.match_rate_by_value * 100).toFixed(2)}%`],
      ],
    ),
  );

  // -------------------------------- finding type vs true cause cross-tab
  const crossTab = new Map<string, Map<string, number>>();
  const causeColumns = new Set<string>([UNLABELLED]);
  // Attribution is per FINDING, over the entities that finding actually fired
  // on — not per residue entry, whose components merge unrelated findings.
  for (const entry of result.residue) {
    for (const finding of entry.findings) {
      const causes = finding.entity_ids
        .map((id) => causeById.get(normalizeId(id)))
        .filter((c): c is NonNullable<typeof c> => c !== undefined);
      const attributed = causes.length === 0 ? [UNLABELLED] : [...new Set(causes)];
      for (const cause of attributed) causeColumns.add(cause);
      const row = crossTab.get(finding.code) ?? new Map<string, number>();
      for (const cause of attributed) row.set(cause, (row.get(cause) ?? 0) + 1);
      crossTab.set(finding.code, row);
    }
  }
  const columns = [...causeColumns].sort((a, b) =>
    a === UNLABELLED ? 1 : b === UNLABELLED ? -1 : a.localeCompare(b),
  );
  console.log("");
  console.log("Finding type vs true cause (per finding, attributed to the entities it fired on)");
  console.log(
    renderTable(
      ["finding_type", ...columns.map((c) => (c === UNLABELLED ? "noise" : c))],
      [...crossTab.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([code, row]) => [code, ...columns.map((c) => String(row.get(c) ?? 0))]),
    ),
  );
  console.log("");
  console.log(
    "Findings that never fired: " +
      (Object.keys(result.metrics.finding_type_counts).length === 0
        ? "(none)"
        : ["NET_MISMATCH", "SETTLEMENT_WITHOUT_BANK_CREDIT", "UNEXPECTED_BANK_CREDIT_ON_HOLD"]
            .filter((code) => !(code in result.metrics.finding_type_counts))
            .join(", ") || "(none)"),
  );

  console.log("");
  if (captured.length !== labels.length) {
    console.log(`FAIL — defect capture ${captured.length}/${labels.length}`);
    process.exit(1);
  }
  console.log(`PASS — defect capture ${captured.length}/${labels.length}`);
}

try {
  main();
} catch (error) {
  console.error(`recoloop: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
