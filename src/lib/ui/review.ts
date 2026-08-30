/**
 * Server-side data access for the exception review UI.
 *
 * Reads the artefacts the matcher and classifier already produced. It computes
 * no matching and no scoring — every number it returns is either read straight
 * off disk or a sum of values already on disk.
 *
 * It never reads the answer key, and nothing in its import graph can:
 * scripts/checkIsolation.ts scans this module as an entry point.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { CONFIDENCE_THRESHOLD } from "../classify/config";
import { CAUSES, INSUFFICIENT_EVIDENCE } from "../classify/schema";

/** Hardcoded, never globbed: the other jsonl files are alternate-provider runs. */
export const CLASSIFICATIONS_FILE = "classifications.jsonl";
export const MATCH_RESULT_FILE = "match_result.json";
export const AUDIT_LOG_FILE = "audit_log.jsonl";

export type ReviewAction = "approve" | "reject" | "reclassify";

export interface AuditEntry {
  timestamp: string;
  residue_id: string;
  action: ReviewAction;
  original_prediction: string;
  final_cause: string;
  reviewer_note: string | null;
  original_confidence: number;
  gate_forced: boolean;
}

export interface ReviewEntity {
  kind: string;
  id: string;
  normalized: Record<string, unknown>;
}

export interface ReviewCandidate {
  kind: string;
  id: string;
  reason: string;
  evidence: Record<string, number | string>;
}

export interface ReviewCase {
  residue_id: string;
  finding_types: string[];
  findings: Array<{ code: string; entity_ids: string[] }>;
  evidence: Record<string, number | string>;
  entities: ReviewEntity[];
  candidates: ReviewCandidate[];
  predicted_cause: string | null;
  confidence: number | null;
  reasoning: string | null;
  proposed_action: string | null;
  proposed_amount_paise: number | null;
  requires_human_review: boolean;
  gate_forced_review: boolean;
  provider: string | null;
  model: string | null;
  /** Which queue group this case belongs to. */
  bucket: "review" | "auto";
}

export interface ReviewSummary {
  residue_count: number;
  review_count: number;
  auto_count: number;
  decided_count: number;
  review_value_paise: number;
  auto_value_paise: number;
  residue_value_paise: number;
  match_rate_by_count: number;
}

export interface ReviewPayload {
  seed: number;
  summary: ReviewSummary;
  cases: ReviewCase[];
  audit: AuditEntry[];
  causes: string[];
  confidence_threshold: number;
}

interface RawResidue {
  residue_id: string;
  finding_types: string[];
  findings: Array<{ code: string; entity_ids: string[] }>;
  entities: Record<string, Array<{ kind: string; id: string; normalized: unknown }>>;
  candidates: ReviewCandidate[];
  evidence: Record<string, number | string>;
}

interface RawMatchResult {
  residue: RawResidue[];
  metrics: {
    residue_count: number;
    residue_value_paise: number;
    match_rate_by_count: number;
  };
}

interface RawClassification {
  residue_id: string;
  provider: string;
  model: string;
  gate_forced_review: boolean;
  classification: {
    predicted_cause: string;
    confidence: number;
    reasoning: string;
    proposed_adjusting_entry: { action: string; amount_paise: number | null } | null;
    requires_human_review: boolean;
  };
}

export function dataDir(seed: number): string {
  return resolve(`data/${seed}`);
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const rows: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // A torn final line from an interrupted write: skip it rather than fail
      // the whole page.
    }
  }
  return rows;
}

export function readAuditLog(seed: number): AuditEntry[] {
  return readJsonl<AuditEntry>(join(dataDir(seed), AUDIT_LOG_FILE));
}

/** Append-only. Never rewrites or removes a prior line. */
export function appendAuditEntry(seed: number, entry: AuditEntry): void {
  appendFileSync(join(dataDir(seed), AUDIT_LOG_FILE), `${JSON.stringify(entry)}\n`, "utf8");
}

export function loadReview(seed: number): ReviewPayload {
  const dir = dataDir(seed);
  const match = JSON.parse(
    readFileSync(join(dir, MATCH_RESULT_FILE), "utf8"),
  ) as RawMatchResult;
  const byId = new Map(
    readJsonl<RawClassification>(join(dir, CLASSIFICATIONS_FILE)).map((r) => [r.residue_id, r]),
  );

  const cases: ReviewCase[] = match.residue.map((entry) => {
    const record = byId.get(entry.residue_id);
    const c = record?.classification;
    const entities: ReviewEntity[] = [];
    for (const group of Object.values(entry.entities)) {
      for (const item of group ?? []) {
        entities.push({
          kind: item.kind,
          id: item.id,
          normalized: (item.normalized ?? {}) as Record<string, unknown>,
        });
      }
    }
    // An unclassified case still needs a human, so it queues as review.
    const requiresReview = c === undefined ? true : c.requires_human_review;
    return {
      residue_id: entry.residue_id,
      finding_types: entry.finding_types,
      findings: entry.findings,
      evidence: entry.evidence,
      entities,
      candidates: entry.candidates,
      predicted_cause: c?.predicted_cause ?? null,
      confidence: c?.confidence ?? null,
      reasoning: c?.reasoning ?? null,
      proposed_action: c?.proposed_adjusting_entry?.action ?? null,
      proposed_amount_paise: c?.proposed_adjusting_entry?.amount_paise ?? null,
      requires_human_review: requiresReview,
      gate_forced_review: record?.gate_forced_review ?? false,
      provider: record?.provider ?? null,
      model: record?.model ?? null,
      bucket: requiresReview ? "review" : "auto",
    };
  });

  // Work queue order: review first (that is the actual job), biggest money first
  // inside each group.
  cases.sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket === "review" ? -1 : 1;
    const av = a.proposed_amount_paise ?? 0;
    const bv = b.proposed_amount_paise ?? 0;
    return bv - av || a.residue_id.localeCompare(b.residue_id);
  });

  const audit = readAuditLog(seed);
  const sumBucket = (bucket: "review" | "auto"): number =>
    cases
      .filter((entry) => entry.bucket === bucket)
      .reduce((total, entry) => total + (entry.proposed_amount_paise ?? 0), 0);

  return {
    seed,
    summary: {
      residue_count: match.metrics.residue_count,
      review_count: cases.filter((entry) => entry.bucket === "review").length,
      auto_count: cases.filter((entry) => entry.bucket === "auto").length,
      decided_count: new Set(audit.map((a) => a.residue_id)).size,
      review_value_paise: sumBucket("review"),
      auto_value_paise: sumBucket("auto"),
      residue_value_paise: match.metrics.residue_value_paise,
      match_rate_by_count: match.metrics.match_rate_by_count,
    },
    cases,
    audit,
    causes: [...CAUSES, INSUFFICIENT_EVIDENCE],
    confidence_threshold: CONFIDENCE_THRESHOLD,
  };
}
