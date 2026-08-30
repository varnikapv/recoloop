/**
 * Matcher-local types. This module intentionally does not import the defect
 * taxonomy — the matcher must not know what a "true cause" is.
 */
import type { NormalizedBankTxn, NormalizedLine, NormalizedOrder } from "../normalize";

/**
 * Finding codes.
 *
 * The first nine are the codes specified for the four stages. The last three are
 * additions: without them three defect classes in the dataset have no code that
 * can ever fire, and would be silently auto-matched as clean. See README.
 */
export const FINDING_CODES = [
  "DUPLICATE_ORDER_PAIR",
  "ORDER_WITHOUT_SETTLEMENT",
  "ORPHAN_SETTLEMENT_LINE",
  "SHORT_CAPTURE",
  "SETTLEMENT_DELAY",
  "SETTLEMENT_WITHOUT_BANK_CREDIT",
  "BANK_CREDIT_WITHOUT_SETTLEMENT",
  "NET_MISMATCH",
  "UNEXPECTED_BANK_CREDIT_ON_HOLD",
  // additions
  "FEE_SLAB_MISMATCH",
  "SETTLEMENT_ON_HOLD",
  "ORDER_STATUS_CONTRADICTION",
] as const;

export type FindingCode = (typeof FINDING_CODES)[number];

export type EntityKind = "order" | "settlement_line" | "settlement" | "bank_txn";

export interface EntityRef {
  kind: EntityKind;
  id: string;
}

export type Evidence = Record<string, number | string>;

export interface Candidate {
  kind: EntityKind;
  id: string;
  /** Why the matcher looked at it, and why it was rejected. */
  reason: string;
  evidence: Evidence;
}

export interface Finding {
  code: FindingCode;
  /**
   * Entities this finding takes OWNERSHIP of. Ownership is what the partition
   * assertion in run.ts is defined over: an owned entity is residue, never
   * matched. Related-but-not-owned ids travel in `evidence` instead.
   */
  entities: EntityRef[];
  evidence: Evidence;
  candidates: Candidate[];
}

export interface MatchedRecord {
  order_id: string | null;
  payment_id: string | null;
  line_id: string;
  line_type: string;
  settlement_id: string;
  bank_txn_id: string;
  net_paise: number;
  verified: true;
}

export interface ExcludedRecord {
  order_id: string;
  reason: "NO_MONEY_MOVEMENT_EXPECTED";
  status: string;
  amount_paise: number;
}

export interface ResidueEntity {
  kind: EntityKind;
  id: string;
  normalized: unknown;
  raw: Record<string, string>;
}

/** Which entities a single finding fired on, kept for exact attribution. */
export interface ResidueFinding {
  code: FindingCode;
  entity_ids: string[];
}

export interface ResidueEntry {
  residue_id: string;
  finding_types: FindingCode[];
  /** The individual findings that merged into this entry. */
  findings: ResidueFinding[];
  entities: {
    orders?: ResidueEntity[];
    settlement_lines?: ResidueEntity[];
    settlements?: ResidueEntity[];
    bank_txns?: ResidueEntity[];
  };
  candidates: Candidate[];
  evidence: Evidence;
}

export interface MatchMetrics {
  total_orders: number;
  total_payments: number;
  total_refunds: number;
  total_adjustments: number;
  total_settlements: number;
  total_bank_rows: number;
  auto_matched_count: number;
  auto_matched_value_paise: number;
  residue_count: number;
  residue_value_paise: number;
  excluded_count: number;
  match_rate_by_count: number;
  match_rate_by_value: number;
  finding_type_counts: Record<string, number>;
}

export interface MatchResult {
  matched: MatchedRecord[];
  residue: ResidueEntry[];
  excluded: ExcludedRecord[];
  /** Batches that reconciled against a bank credit, line disputes aside. */
  reconciled_settlements: string[];
  reconciled_bank_txns: string[];
  metrics: MatchMetrics;
}

/** Convenience view of one settlement, rebuilt from its lines. */
export interface SettlementGroup {
  settlement_id: string;
  utr: string;
  status: "processed" | "on_hold";
  settled_at: string;
  /** sum(credit) - sum(debit) across this settlement's own lines. */
  expected_net_paise: number;
  /** The net the report states in its header, repeated on every line. */
  stated_net_paise: number;
  lines: NormalizedLine[];
}

export interface StageInput {
  orders: NormalizedOrder[];
  lines: NormalizedLine[];
  bank: NormalizedBankTxn[];
}

export const entityKey = (kind: EntityKind, id: string): string => `${kind}:${id}`;
