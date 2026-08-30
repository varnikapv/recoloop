#!/usr/bin/env tsx
/**
 * RecoLoop synthetic dataset generator.
 *
 *   npx tsx scripts/generate.ts --seed 42 --orders 500 --defects 40
 *
 * Writes data/<seed>/{orders.csv,settlement_report.csv,bank_statement.csv,labels.json}
 */
import { resolve } from "node:path";

import { parseArgs, renderTable } from "../src/lib/cli";
import { CAUSE_DESCRIPTION } from "../src/lib/defects";
import { writeDataset } from "../src/lib/emit";
import { generateDataset } from "../src/lib/generate";
import type { DefectCause } from "../src/lib/types";

function main(): void {
  const args = parseArgs(process.argv.slice(2), {
    seed: 42,
    orders: 500,
    defects: 40,
    out: "",
  });

  const seed = Math.trunc(args.seed);
  const outDir = resolve(args.out === "" ? `data/${seed}` : args.out);

  const { dataset, plan } = generateDataset({
    seed,
    orders: Math.trunc(args.orders),
    defects: Math.trunc(args.defects),
  });
  const files = writeDataset(dataset, seed, outDir);

  const byCause = new Map<DefectCause, number>();
  for (const label of dataset.labels) {
    byCause.set(label.true_cause, (byCause.get(label.true_cause) ?? 0) + 1);
  }

  const rows = [...plan.entries()]
    .filter(([, count]) => count > 0)
    .map(([cause, count]) => [
      cause,
      String(count),
      String(byCause.get(cause) ?? 0),
      CAUSE_DESCRIPTION[cause].split(". ")[0] ?? "",
    ]);

  console.log(`RecoLoop dataset  seed=${seed}  orders=${dataset.orders.length}`);
  console.log("");
  console.log(
    renderTable(["source", "rows"], [
      ["orders.csv", String(dataset.orders.length)],
      ["settlement_report.csv", String(dataset.lines.length)],
      ["bank_statement.csv", String(dataset.bank.length)],
      ["settlements", String(dataset.settlements.length)],
      ["refunds", String(dataset.refunds.length)],
    ]),
  );
  console.log("");
  console.log("Injected defects");
  console.log(renderTable(["cause", "planned", "injected", "meaning"], rows));
  console.log("");
  console.log(`total: ${dataset.labels.length} defect(s) across ${rows.length} cause(s)`);
  console.log("");
  console.log(`wrote ${files.orders}`);
  console.log(`wrote ${files.settlementReport}`);
  console.log(`wrote ${files.bankStatement}`);
  console.log(`wrote ${files.labels}  <- ground truth, the only copy`);
}

try {
  main();
} catch (error) {
  console.error(`recoloop: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
