#!/usr/bin/env tsx
/**
 * RecoLoop deterministic matcher.
 *
 *   npx tsx scripts/match.ts --seed 42
 *
 * Reads data/<seed>/{orders,settlement_report,bank_statement}.csv and writes
 * match_result.json + normalize_log.json beside them. Never reads labels.json.
 */
import { resolve } from "node:path";

import { parseArgs, renderTable } from "../src/lib/cli";
import { runMatch } from "../src/lib/match/run";

function main(): void {
  const args = parseArgs(process.argv.slice(2), { seed: 42, dir: "" });
  const seed = Math.trunc(args.seed);
  const dir = resolve(args.dir === "" ? `data/${seed}` : args.dir);

  const { dataset, result, files } = runMatch(dir);
  const { metrics, day_delta_histogram: histogram } = result;

  console.log(`RecoLoop match  ${dir}`);
  console.log("");
  console.log("Stage 0 — normalisation corrections");
  console.log(
    renderTable(
      ["field", "rows corrected"],
      Object.entries(dataset.log.corrections_by_field).map(([field, count]) => [
        field,
        String(count),
      ]),
    ),
  );
  console.log(`total: ${dataset.log.total_corrections} correction(s)`);
  console.log("");

  console.log("Inputs");
  console.log(
    renderTable(
      ["entity", "count"],
      [
        ["orders", String(metrics.total_orders)],
        ["payment lines", String(metrics.total_payments)],
        ["refund lines", String(metrics.total_refunds)],
        ["adjustment lines", String(metrics.total_adjustments)],
        ["settlements", String(metrics.total_settlements)],
        ["bank rows", String(metrics.total_bank_rows)],
      ],
    ),
  );
  console.log("");

  console.log("Findings");
  console.log(
    renderTable(
      ["code", "count"],
      Object.entries(metrics.finding_type_counts).map(([code, count]) => [code, String(count)]),
    ),
  );
  console.log("");

  console.log("Settlement day-delta distribution (T+2 expected)");
  console.log(
    renderTable(
      ["day delta", "lines"],
      Object.entries(histogram).map(([delta, count]) => [
        `T+${delta}`,
        String(count),
      ]),
    ),
  );
  console.log("");

  console.log("Outcome");
  console.log(
    renderTable(
      ["measure", "value"],
      [
        ["auto-matched lines", String(metrics.auto_matched_count)],
        ["auto-matched value (paise)", String(metrics.auto_matched_value_paise)],
        ["residue entries", String(metrics.residue_count)],
        ["residue value (paise)", String(metrics.residue_value_paise)],
        ["excluded orders (no money expected)", String(metrics.excluded_count)],
        ["match rate by count", `${(metrics.match_rate_by_count * 100).toFixed(2)}%`],
        ["match rate by value", `${(metrics.match_rate_by_value * 100).toFixed(2)}%`],
      ],
    ),
  );
  console.log("");
  console.log(`wrote ${files.matchResult}`);
  console.log(`wrote ${files.normalizeLog}`);
}

try {
  main();
} catch (error) {
  console.error(`recoloop: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
