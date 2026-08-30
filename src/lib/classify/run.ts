/**
 * Classification orchestration: one call per residue entry, schema validation
 * with a single repair retry, the confidence gate, and incremental resumable
 * writes.
 *
 * Nothing here reads labels.json, and nothing in this module's import graph can
 * — scripts/checkIsolation.ts enforces it as a build step.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import type { ResidueEntry } from "../match/types";
import { CONFIDENCE_THRESHOLD, INTER_CALL_DELAY_MS, MAX_VALIDATION_ATTEMPTS } from "./config";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt";
import type { Provider } from "./provider";
import {
  type Classification,
  INSUFFICIENT_EVIDENCE,
  validateClassification,
} from "./schema";

export type RecordStatus = "ok" | "repaired" | "schema_failure" | "transport_failure";

export interface ClassificationRecord {
  residue_id: string;
  provider: string;
  model: string;
  status: RecordStatus;
  attempts: number;
  /** True when the confidence gate overrode the model's own review flag. */
  gate_forced_review: boolean;
  validation_errors: string[];
  latency_ms: number;
  classification: Classification;
}

/**
 * The gate. A label below the threshold is not a proposal, it is a "look at
 * this" flag — so requires_human_review is forced true regardless of what the
 * model said about itself.
 */
export function applyConfidenceGate(classification: Classification): {
  gated: Classification;
  forced: boolean;
} {
  const mustReview =
    classification.confidence < CONFIDENCE_THRESHOLD ||
    classification.predicted_cause === INSUFFICIENT_EVIDENCE;
  const requiresReview = classification.requires_human_review || mustReview;
  const forced = mustReview && !classification.requires_human_review;
  return { gated: { ...classification, requires_human_review: requiresReview }, forced };
}

function fallbackRecord(
  entry: ResidueEntry,
  provider: Provider,
  status: RecordStatus,
  attempts: number,
  errors: string[],
  latencyMs: number,
): ClassificationRecord {
  return {
    residue_id: entry.residue_id,
    provider: provider.name,
    model: provider.model,
    status,
    attempts,
    gate_forced_review: true,
    validation_errors: errors,
    latency_ms: latencyMs,
    classification: {
      residue_id: entry.residue_id,
      predicted_cause: INSUFFICIENT_EVIDENCE,
      confidence: 0,
      reasoning:
        status === "schema_failure"
          ? `The model's output failed schema validation twice; falling through to human review. Last error: ${errors[errors.length - 1] ?? "unknown"}`
          : `The model call failed: ${errors[errors.length - 1] ?? "unknown"}`,
      proposed_adjusting_entry: null,
      requires_human_review: true,
    },
  };
}

/** One entry, one call, at most one repair retry. Never throws. */
export async function classifyEntry(
  entry: ResidueEntry,
  provider: Provider,
): Promise<ClassificationRecord> {
  const started = Date.now();
  const errors: string[] = [];
  const baseUser = buildUserPrompt(entry);

  for (let attempt = 1; attempt <= MAX_VALIDATION_ATTEMPTS; attempt++) {
    const user =
      attempt === 1
        ? baseUser
        : `${baseUser}\n\nYour previous response did not satisfy the output schema: ${errors[errors.length - 1]}\nReturn a single record_classification call that satisfies every field constraint.`;

    let raw: unknown;
    try {
      raw = await provider.classify({ system: SYSTEM_PROMPT, user });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return fallbackRecord(entry, provider, "transport_failure", attempt, errors, Date.now() - started);
    }

    const outcome = validateClassification(raw);
    if (!outcome.ok || outcome.value === undefined) {
      errors.push(outcome.error ?? "unknown validation error");
      if (attempt === MAX_VALIDATION_ATTEMPTS) {
        return fallbackRecord(entry, provider, "schema_failure", attempt, errors, Date.now() - started);
      }
      continue;
    }

    // The model may echo a wrong id; the case id is authoritative for joining.
    const withId: Classification = { ...outcome.value, residue_id: entry.residue_id };
    const { gated, forced } = applyConfidenceGate(withId);
    return {
      residue_id: entry.residue_id,
      provider: provider.name,
      model: provider.model,
      status: attempt === 1 ? "ok" : "repaired",
      attempts: attempt,
      gate_forced_review: forced,
      validation_errors: errors,
      latency_ms: Date.now() - started,
      classification: gated,
    };
  }

  return fallbackRecord(entry, provider, "schema_failure", MAX_VALIDATION_ATTEMPTS, errors, Date.now() - started);
}

export interface LoadedRecords {
  completed: Map<string, ClassificationRecord>;
  /** Lines that could not be parsed — a half-written line from a crashed run. */
  tornLines: number;
}

/** residue_ids already present in the output file, so a rerun resumes. */
export function loadCompleted(path: string): LoadedRecords {
  const completed = new Map<string, ClassificationRecord>();
  let tornLines = 0;
  if (!existsSync(path)) return { completed, tornLines };
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    try {
      const record = JSON.parse(text) as ClassificationRecord;
      if (typeof record.residue_id === "string") completed.set(record.residue_id, record);
      else tornLines++;
    } catch {
      tornLines++;
    }
  }
  return { completed, tornLines };
}

/**
 * Rewrite the file from the records that parsed, dropping any half-written line
 * a crash left behind. Without this the torn line survives every rerun and the
 * artefact stays permanently unparseable for anything stricter than the loader.
 */
function compact(path: string, completed: Map<string, ClassificationRecord>): void {
  const body = [...completed.values()].map((record) => JSON.stringify(record)).join("\n");
  writeFileSync(path, body === "" ? "" : `${body}\n`, "utf8");
}

export interface RunProgress {
  index: number;
  total: number;
  record: ClassificationRecord;
}

/**
 * A transport failure means the model never actually saw the case — the call
 * died in the network or was rejected before inference. Resuming must NOT treat
 * that as done, or a run interrupted by an outage or a billing block leaves
 * permanent holes that a rerun silently skips. A schema failure IS a real model
 * verdict (it was asked twice), so it is only redone on request.
 */
export function isResumable(record: ClassificationRecord, retryFailed: boolean): boolean {
  if (record.status === "transport_failure") return false;
  if (record.status === "schema_failure") return !retryFailed;
  return true;
}

export interface RunOptions {
  entries: readonly ResidueEntry[];
  provider: Provider;
  outputPath: string;
  /** Also redo entries whose output failed schema validation twice. */
  retryFailed?: boolean;
  onProgress?: (progress: RunProgress) => void;
  onSkip?: (residueId: string, index: number, total: number) => void;
}

export interface RunSummary {
  written: number;
  skipped: number;
  /** Entries retried because a previous run never reached the model. */
  retriedFailures: number;
  /** Half-written lines dropped from a previous crashed run. */
  repairedLines: number;
  records: ClassificationRecord[];
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Results are appended one line at a time as each call returns, so a crash on
 * case 90 of 100 keeps the first 89.
 */
export async function runClassification(options: RunOptions): Promise<RunSummary> {
  const retryFailed = options.retryFailed ?? false;
  const { completed, tornLines } = loadCompleted(options.outputPath);
  // Drop records that do not count as done, so they are re-called and the file
  // never keeps two rows for one case.
  let retriedFailures = 0;
  for (const [id, record] of [...completed]) {
    if (!isResumable(record, retryFailed)) {
      completed.delete(id);
      retriedFailures++;
    }
  }
  if (tornLines > 0 || retriedFailures > 0) compact(options.outputPath, completed);
  const records: ClassificationRecord[] = [];
  let written = 0;
  let skipped = 0;

  for (const [index, entry] of options.entries.entries()) {
    const existing = completed.get(entry.residue_id);
    if (existing !== undefined) {
      records.push(existing);
      skipped++;
      options.onSkip?.(entry.residue_id, index + 1, options.entries.length);
      continue;
    }

    const record = await classifyEntry(entry, options.provider);
    appendFileSync(options.outputPath, `${JSON.stringify(record)}\n`, "utf8");
    records.push(record);
    written++;
    options.onProgress?.({ index: index + 1, total: options.entries.length, record });
    if (INTER_CALL_DELAY_MS > 0) await sleep(INTER_CALL_DELAY_MS);
  }

  return { written, skipped, retriedFailures, repairedLines: tornLines, records };
}
