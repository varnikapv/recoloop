#!/usr/bin/env tsx
/**
 * Classifies every residue entry from the matcher.
 *
 *   npx tsx scripts/classify.ts --seed 42
 *   npx tsx scripts/classify.ts --seed 42 --provider gemini  # Gemini free tier
 *   npx tsx scripts/classify.ts --seed 42 --provider rules   # offline baseline
 *
 * Appends one JSON object per line to data/<seed>/classifications.jsonl as each
 * call returns. Rerunning skips entries already present, so an interrupted run
 * resumes instead of re-spending tokens. Never reads labels.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseArgs, renderTable } from "../src/lib/cli";
import {
  resolveGeminiMinIntervalMs,
  resolveGeminiModel,
  resolveModel,
  resolveProviderKind,
  type ProviderKind,
} from "../src/lib/classify/config";
import { createGeminiProvider } from "../src/lib/classify/geminiProvider";
import { createAnthropicProvider, type Provider } from "../src/lib/classify/provider";
import { createRulesProvider } from "../src/lib/classify/rulesProvider";
import { type ClassificationRecord, runClassification } from "../src/lib/classify/run";
import type { MatchResult, ResidueEntry } from "../src/lib/match/types";

/**
 * Load .env if present, without adding a dependency. Values already exported in
 * the environment win. .env is gitignored; only .env.example is ever tracked.
 */
function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  if (typeof process.loadEnvFile === "function") process.loadEnvFile(".env");
}

const onRetry = ({ attempt, status, waitMs }: { attempt: number; status: number; waitMs: number }): void => {
  console.log(`    retry ${attempt} after HTTP ${status}, waiting ${waitMs}ms`);
};

/**
 * Keys are checked here, at startup, so a missing one fails before the first
 * call rather than 40 calls into a batch.
 */
function requireKey(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is not set. Put it in .env (gitignored) or export it, then rerun — ` +
        "or use --provider rules for the offline deterministic baseline.",
    );
  }
  return value;
}

/**
 * Ranks cases by how much the taxonomy mapping is in doubt, so a run cut short
 * by a quota spends its budget on the cases that actually test the classifier
 * rather than on unambiguous ones.
 *
 * Derived purely from finding codes and matcher evidence — it never reads
 * labels, and would pass checkIsolation.ts unchanged.
 */
function ambiguityRank(entry: ResidueEntry): number {
  let rank = 0;
  // Several findings merged into one case: which cause dominates is a judgement.
  if (entry.finding_types.length > 1) rank += 3;
  // T+3 is the boundary between a late settlement and a normal one whose
  // capture crossed midnight — the single hardest call in the taxonomy.
  const dayDelta = entry.evidence["day_delta"];
  if (entry.finding_types.includes("SETTLEMENT_DELAY") && typeof dayDelta === "number" && dayDelta <= 3) {
    rank += 2;
  }
  // An orphan line is a prior-cycle refund or a chargeback depending on its type.
  if (entry.finding_types.includes("ORPHAN_SETTLEMENT_LINE")) rank += 1;
  // A paid order with no settlement is a duplicate only if a twin exists.
  if (entry.finding_types.includes("ORDER_WITHOUT_SETTLEMENT")) rank += 1;
  return rank;
}

function orderEntries(entries: readonly ResidueEntry[], order: string): ResidueEntry[] {
  if (order === "" || order === "file") return [...entries];
  if (order !== "ambiguous") throw new Error(`unknown --order ${order} (use "file" or "ambiguous")`);
  return [...entries].sort(
    (a, b) => ambiguityRank(b) - ambiguityRank(a) || a.residue_id.localeCompare(b.residue_id),
  );
}

function pickProvider(
  kind: ProviderKind,
  modelOverride: string,
  entries: readonly ResidueEntry[],
): Provider {
  if (kind === "rules") {
    return createRulesProvider(new Map(entries.map((e) => [e.residue_id, e])));
  }
  if (kind === "gemini") {
    const minIntervalMs = resolveGeminiMinIntervalMs();
    return createGeminiProvider({
      model: resolveGeminiModel(modelOverride),
      apiKey: requireKey("GEMINI_API_KEY"),
      minIntervalMs,
      onRetry,
      onPace: (waitMs) => {
        console.log(`    pacing ${waitMs}ms to stay under the free-tier per-minute cap`);
      },
    });
  }
  return createAnthropicProvider({
    model: resolveModel(modelOverride),
    apiKey: requireKey("ANTHROPIC_API_KEY"),
    onRetry,
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), {
    seed: 42,
    dir: "",
    provider: "",
    model: "",
    limit: 0,
    "retry-failed": false,
    fresh: false,
    order: "",
  });
  loadDotEnv();
  const seed = Math.trunc(args.seed);
  const dir = resolve(args.dir === "" ? `data/${seed}` : args.dir);
  const outputPath = join(dir, "classifications.jsonl");

  const result = JSON.parse(
    readFileSync(join(dir, "match_result.json"), "utf8"),
  ) as MatchResult;
  const ordered = orderEntries(result.residue, args.order);
  const limit = Math.trunc(args.limit);
  const entries = limit > 0 ? ordered.slice(0, limit) : ordered;

  const provider = pickProvider(resolveProviderKind(args.provider), args.model, entries);

  console.log(`RecoLoop classify  ${dir}`);
  console.log(`  provider: ${provider.name}   model: ${provider.model}`);
  console.log(
    `  ${entries.length} residue entr(ies), one API call each, temperature 0` +
      (args.order === "ambiguous" ? "  [hardest cases first]" : ""),
  );
  console.log("");

  const summary = await runClassification({
    entries,
    provider,
    outputPath,
    retryFailed: args["retry-failed"],
    fresh: args.fresh,
    onSkip: (id, index, total) => {
      console.log(`[${index}/${total}] ${id}  skipped (already classified)`);
    },
    onProgress: ({ index, total, record }) => {
      const c = record.classification;
      const flag = c.requires_human_review ? "REVIEW" : "auto  ";
      console.log(
        `[${index}/${total}] ${record.residue_id}  ${flag}  ${c.predicted_cause.padEnd(22)} ` +
          `conf=${c.confidence.toFixed(2)}  ${record.status}  ${record.latency_ms}ms`,
      );
    },
  });

  const byStatus = new Map<string, number>();
  const byCause = new Map<string, number>();
  let review = 0;
  let gated = 0;
  for (const record of summary.records) {
    byStatus.set(record.status, (byStatus.get(record.status) ?? 0) + 1);
    const cause = record.classification.predicted_cause;
    byCause.set(cause, (byCause.get(cause) ?? 0) + 1);
    if (record.classification.requires_human_review) review++;
    if (record.gate_forced_review) gated++;
  }

  console.log("");
  console.log("Run summary");
  console.log(
    renderTable(
      ["measure", "value"],
      [
        ["classified this run", String(summary.written)],
        ["skipped (resumed)", String(summary.skipped)],
        ...(summary.retriedFailures > 0
          ? [["re-called (previous run never reached the model)", String(summary.retriedFailures)]]
          : []),
        ...(summary.repairedLines > 0
          ? [["torn lines dropped from a crashed run", String(summary.repairedLines)]]
          : []),
        ["auto-approved", String(summary.records.length - review)],
        ["requires human review", String(review)],
        ["  of which forced by the confidence gate", String(gated)],
        ...[...byStatus.entries()].sort().map(([status, n]) => [`status: ${status}`, String(n)]),
      ],
    ),
  );
  console.log("");
  console.log("Predicted causes");
  console.log(
    renderTable(
      ["predicted_cause", "count"],
      [...byCause.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(
        ([cause, n]) => [cause, String(n)],
      ),
    ),
  );
  console.log("");
  console.log(`wrote ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(`recoloop: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
