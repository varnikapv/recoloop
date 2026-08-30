#!/usr/bin/env tsx
/**
 * Scores classifications.jsonl against ground truth.
 *
 * Reads labels.json (through the single loader), classifications.jsonl and
 * match_result.json. This is a report, not a correctness gate: it always
 * exits 0.
 *
 *   npx tsx scripts/scoreClassify.ts --seed 42
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseArgs, renderTable } from "../src/lib/cli";
import { CONFIDENCE_THRESHOLD } from "../src/lib/classify/config";
import { CAUSES, INSUFFICIENT_EVIDENCE } from "../src/lib/classify/schema";
import type { ClassificationRecord } from "../src/lib/classify/run";
import { loadLabels } from "../src/lib/labels";
import type { MatchResult, ResidueEntry } from "../src/lib/match/types";
import { formatIndianRupees } from "../src/lib/money";

const NO_DEFECT = "(no defect)";

const SHORT: Readonly<Record<string, string>> = {
  LATE_SETTLEMENT: "LATE",
  REFUND_NETTED: "RFND",
  PARTIAL_CAPTURE: "PART",
  FEE_VARIANCE: "FEE",
  ON_HOLD: "HOLD",
  DUPLICATE_WEBHOOK: "DUP",
  SILENT_UPI_FAIL: "SILNT",
  CHARGEBACK_DEBIT: "CHRGB",
  UNEXPLAINED: "UNEXP",
  [INSUFFICIENT_EVIDENCE]: "INSUF",
  [NO_DEFECT]: "none",
};

const rupees = (paise: number): string => `Rs ${formatIndianRupees(paise)}`;
const norm = (id: string): string => id.trim().toLowerCase();

function entityIds(entry: ResidueEntry): string[] {
  return [
    ...(entry.entities.orders ?? []),
    ...(entry.entities.settlement_lines ?? []),
    ...(entry.entities.settlements ?? []),
    ...(entry.entities.bank_txns ?? []),
  ].map((e) => norm(e.id));
}

function rule(width: number, char = "="): string {
  return char.repeat(width);
}

interface Observation {
  residue_id: string;
  /** The true cause of one labelled defect, or NO_DEFECT for a noise entry. */
  gold: string;
  predicted: string;
  confidence: number;
  autoApproved: boolean;
  correct: boolean;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2), { seed: 42, dir: "" });
  const seed = Math.trunc(args.seed);
  const dir = resolve(args.dir === "" ? `data/${seed}` : args.dir);

  const labels = loadLabels(dir);
  const matchResult = JSON.parse(
    readFileSync(join(dir, "match_result.json"), "utf8"),
  ) as MatchResult;
  // Tolerate a half-written line from a crashed run rather than dying on it.
  let tornLines = 0;
  const records: ClassificationRecord[] = [];
  for (const line of readFileSync(join(dir, "classifications.jsonl"), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as ClassificationRecord);
    } catch {
      tornLines++;
    }
  }

  const recordById = new Map(records.map((r) => [r.residue_id, r]));
  const causeById = new Map(labels.map((l) => [norm(l.record_id), l.true_cause]));

  // ---------------------------------------------------------- observations
  const observations: Observation[] = [];
  const entryTruth = new Map<string, string[]>();
  let unclassifiedEntries = 0;
  let multiDefectEntries = 0;

  for (const entry of matchResult.residue) {
    const causes = entityIds(entry)
      .map((id) => causeById.get(id))
      .filter((c): c is NonNullable<typeof c> => c !== undefined)
      .map((c) => c as string);
    entryTruth.set(entry.residue_id, causes);
    if (causes.length > 1) multiDefectEntries++;

    const record = recordById.get(entry.residue_id);
    if (record === undefined) {
      unclassifiedEntries++;
      continue;
    }
    const c = record.classification;
    const autoApproved = !c.requires_human_review;

    if (causes.length === 0) {
      observations.push({
        residue_id: entry.residue_id,
        gold: NO_DEFECT,
        predicted: c.predicted_cause,
        confidence: c.confidence,
        autoApproved,
        correct: c.predicted_cause === INSUFFICIENT_EVIDENCE,
      });
      continue;
    }
    for (const gold of causes) {
      observations.push({
        residue_id: entry.residue_id,
        gold,
        predicted: c.predicted_cause,
        confidence: c.confidence,
        autoApproved,
        correct: c.predicted_cause === gold,
      });
    }
  }

  const defectObs = observations.filter((o) => o.gold !== NO_DEFECT);
  const noiseObs = observations.filter((o) => o.gold === NO_DEFECT);
  const correctDefects = defectObs.filter((o) => o.correct).length;
  // One prediction per entry, so an entry bundling two defects can only ever
  // name one of them: the ceiling is the number of defect-bearing entries.
  const ceiling = new Set(defectObs.map((o) => o.residue_id)).size;

  // ------------------------------------------------------ financial risk
  let autoApprovedExposure = 0;
  let wrongAutoApprovedExposure = 0;
  let wrongAutoApprovedEntries = 0;
  let autoApprovedEntries = 0;
  const wrongAutoRows: string[][] = [];

  for (const entry of matchResult.residue) {
    const record = recordById.get(entry.residue_id);
    if (record === undefined) continue;
    const c = record.classification;
    if (c.requires_human_review) continue;
    autoApprovedEntries++;
    const amount = c.proposed_adjusting_entry?.amount_paise ?? 0;
    autoApprovedExposure += amount;

    const truth = entryTruth.get(entry.residue_id) ?? [];
    const wrong =
      truth.length === 0
        ? c.predicted_cause !== INSUFFICIENT_EVIDENCE
        : !truth.includes(c.predicted_cause);
    if (wrong) {
      wrongAutoApprovedEntries++;
      wrongAutoApprovedExposure += amount;
      wrongAutoRows.push([
        entry.residue_id,
        truth.length === 0 ? NO_DEFECT : truth.join("+"),
        c.predicted_cause,
        c.confidence.toFixed(2),
        String(amount),
        c.proposed_adjusting_entry?.action ?? "(none)",
      ]);
    }
  }

  // -------------------------------------------------------------- headline
  const provider = records[0]?.provider ?? "(none)";
  const model = records[0]?.model ?? "(none)";
  const headline =
    `  ${correctDefects}/${labels.length} defects correctly classified   ·   ` +
    `${wrongAutoApprovedEntries} auto-approved wrong   ·   ` +
    `${rupees(wrongAutoApprovedExposure)} at risk in wrong auto-approvals`;
  const width = Math.max(headline.length + 2, 78);

  console.log(rule(width));
  console.log(headline);
  console.log(rule(width));
  console.log(
    `RecoLoop classify score  ${dir}\n` +
      `  provider=${provider}  model=${model}  confidence_threshold=${CONFIDENCE_THRESHOLD}\n` +
      `  ${matchResult.residue.length} residue entries, ${records.length} classified` +
      (unclassifiedEntries > 0 ? `, ${unclassifiedEntries} MISSING` : "") +
      (tornLines > 0 ? `, ${tornLines} unparseable line(s) skipped` : ""),
  );
  if (unclassifiedEntries > 0) {
    // On a partial run the ceiling is dominated by what has not been classified
    // yet, so reporting it as a taxonomy ceiling would be misleading.
    console.log(
      `  PARTIAL RUN: ${unclassifiedEntries} of ${matchResult.residue.length} entries are not classified.\n` +
        `  Scores below cover only the ${records.length} that are, and are NOT comparable to a full run.`,
    );
  } else if (multiDefectEntries > 0) {
    console.log(
      `  ceiling: ${multiDefectEntries} residue entr(ies) bundle two real defects, and one\n` +
        `  prediction cannot name both — so ${ceiling}/${labels.length} is the maximum achievable here.`,
    );
  }
  console.log("");

  // ------------------------------- the gate split: the number that matters
  const bucket = (auto: boolean) => {
    const rows = defectObs.filter((o) => o.autoApproved === auto);
    const correct = rows.filter((o) => o.correct).length;
    return {
      entries: new Set(rows.map((o) => o.residue_id)).size,
      defects: rows.length,
      correct,
      accuracy: rows.length === 0 ? null : correct / rows.length,
    };
  };
  const auto = bucket(true);
  const review = bucket(false);
  const pct = (value: number | null): string => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);

  console.log(rule(width, "-"));
  console.log("  ACCURACY SPLIT BY THE CONFIDENCE GATE  — the point of the whole layer");
  console.log(rule(width, "-"));
  console.log(
    renderTable(
      ["bucket", "entries", "defects", "correct", "accuracy"],
      [
        ["auto-approved (requires_human_review=false)", String(auto.entries), String(auto.defects), String(auto.correct), pct(auto.accuracy)],
        ["sent to human review (=true)", String(review.entries), String(review.defects), String(review.correct), pct(review.accuracy)],
      ],
    ),
  );
  console.log("");
  console.log(rule(width, "-"));
  console.log("  FINANCIAL RISK IN THE AUTO-APPROVED BUCKET");
  console.log(rule(width, "-"));
  console.log(
    renderTable(
      ["measure", "value"],
      [
        ["auto-approved entries", String(autoApprovedEntries)],
        ["value proposed for booking without a human", rupees(autoApprovedExposure)],
        ["auto-approved entries with a WRONG prediction", String(wrongAutoApprovedEntries)],
        ["value at risk in those wrong auto-approvals", rupees(wrongAutoApprovedExposure)],
      ],
    ),
  );
  if (wrongAutoRows.length > 0) {
    console.log("");
    console.log("  Every wrong auto-approval, itemised. This is not a bug to hide — it is the");
    console.log("  exact money a human review step exists to catch, and the cost of removing it.");
    console.log(
      renderTable(
        ["residue_id", "true cause", "predicted", "conf", "paise", "proposed action"],
        wrongAutoRows.map((row) => [
          row[0] ?? "",
          row[1] ?? "",
          row[2] ?? "",
          row[3] ?? "",
          row[4] ?? "",
          (row[5] ?? "").slice(0, 46),
        ]),
      ),
    );
  }
  console.log("");

  // --------------------------------------------- per-class precision/recall
  const classes = [...CAUSES, INSUFFICIENT_EVIDENCE];
  const prfRows = classes.map((cls) => {
    const tp = observations.filter((o) => o.predicted === cls && o.gold === cls).length;
    const predicted = observations.filter((o) => o.predicted === cls).length;
    const actual = observations.filter((o) => o.gold === cls).length;
    const precision = predicted === 0 ? null : tp / predicted;
    const recall = actual === 0 ? null : tp / actual;
    const f1 =
      precision === null || recall === null || precision + recall === 0
        ? null
        : (2 * precision * recall) / (precision + recall);
    return [cls, String(actual), String(predicted), String(tp), pct(precision), pct(recall), pct(f1)];
  });
  console.log("Per-class precision / recall / F1  (over 1 observation per labelled defect + 1 per noise entry)");
  console.log(
    renderTable(["class", "actual", "predicted", "correct", "precision", "recall", "F1"], prfRows),
  );
  console.log("");

  // ------------------------------- what the classifier did with matcher noise
  console.log("Matcher false positives — entries that carry NO real defect");
  console.log("  (a different question from classifying real defects: does it know when the matcher was wrong?)");
  const noiseByPrediction = new Map<string, { count: number; review: number; conf: number[] }>();
  for (const obs of noiseObs) {
    const bucketRow = noiseByPrediction.get(obs.predicted) ?? { count: 0, review: 0, conf: [] };
    bucketRow.count++;
    if (!obs.autoApproved) bucketRow.review++;
    bucketRow.conf.push(obs.confidence);
    noiseByPrediction.set(obs.predicted, bucketRow);
  }
  console.log(
    renderTable(
      ["classifier said", "entries", "sent to review", "mean confidence", "verdict"],
      [...noiseByPrediction.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .map(([prediction, stat]) => [
          prediction,
          String(stat.count),
          String(stat.review),
          (stat.conf.reduce((s, n) => s + n, 0) / stat.conf.length).toFixed(2),
          prediction === INSUFFICIENT_EVIDENCE ? "correct — no cause is supported" : "over-called a normal case",
        ]),
    ),
  );
  console.log("");

  // ---------------------------------------------------------- confusion matrix
  const goldRows = [...CAUSES, NO_DEFECT];
  const predCols = [...CAUSES, INSUFFICIENT_EVIDENCE];
  console.log("Confusion matrix — rows are truth, columns are the prediction");
  console.log(
    renderTable(
      ["true \\ pred", ...predCols.map((c) => SHORT[c] ?? c), "tot"],
      goldRows.map((gold) => {
        const cells = predCols.map(
          (pred) =>
            observations.filter((o) => o.gold === gold && o.predicted === pred).length,
        );
        const total = cells.reduce((s, n) => s + n, 0);
        return [
          `${SHORT[gold] ?? gold} ${gold === NO_DEFECT ? "" : ""}`.trim(),
          ...cells.map((n) => (n === 0 ? "." : String(n))),
          String(total),
        ];
      }),
    ),
  );
  console.log(`  legend: ${goldRows.concat([INSUFFICIENT_EVIDENCE]).map((c) => `${SHORT[c] ?? c}=${c}`).join("  ")}`);
  console.log("");
  console.log(
    `Overall: ${correctDefects}/${defectObs.length} labelled defects correct` +
      ` (${pct(defectObs.length === 0 ? null : correctDefects / defectObs.length)}), ` +
      `${noiseObs.filter((o) => o.correct).length}/${noiseObs.length} matcher false positives correctly declined.`,
  );
}

try {
  main();
} catch (error) {
  console.error(`recoloop: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
