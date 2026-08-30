/**
 * Stage 3 — settlement group to bank credit.
 *
 * Pure: (normalized records) -> findings. No I/O.
 *
 * Every settlement leaves this stage in exactly one state: reconciled against a
 * bank credit, or carrying a settlement-level finding. That totality is what
 * makes the partition assertion in run.ts possible.
 */
import type { NormalizedBankTxn, NormalizedLine } from "../normalize";
import type { Candidate, EntityRef, Finding, SettlementGroup } from "./types";

/** Rounding slack when comparing a batch net to a bank credit. */
export const NET_TOLERANCE_PAISE = 1;

/** How close a bank credit has to be to count as a near miss worth surfacing. */
const CANDIDATE_WINDOW_PAISE = 500_00;

export function groupSettlements(lines: readonly NormalizedLine[]): SettlementGroup[] {
  const groups = new Map<string, NormalizedLine[]>();
  for (const line of lines) {
    const bucket = groups.get(line.settlement_id);
    if (bucket) bucket.push(line);
    else groups.set(line.settlement_id, [line]);
  }
  return [...groups.entries()]
    .map(([settlement_id, groupLines]) => {
      const head = groupLines[0] as NormalizedLine;
      let net = 0;
      for (const line of groupLines) net += line.credit_paise - line.debit_paise;
      return {
        settlement_id,
        utr: head.settlement_utr,
        status: head.settlement_status,
        settled_at: head.settled_at,
        expected_net_paise: net,
        stated_net_paise: head.settlement_net_amount_paise,
        lines: [...groupLines].sort((a, b) => a.entity_id.localeCompare(b.entity_id)),
      };
    })
    .sort((a, b) => a.settlement_id.localeCompare(b.settlement_id));
}

export interface SettlementBankResult {
  findings: Finding[];
  groups: SettlementGroup[];
  /** settlement_id -> the bank row it reconciled against. */
  bankBySettlement: Map<string, NormalizedBankTxn>;
  matchedSettlementIds: Set<string>;
  matchedBankIds: Set<string>;
}

/** Everything the settlement owns when it fails to reconcile. */
function ownedBySettlement(group: SettlementGroup, bankTxnId?: string): EntityRef[] {
  const refs: EntityRef[] = [{ kind: "settlement", id: group.settlement_id }];
  for (const line of group.lines) {
    refs.push({ kind: "settlement_line", id: line.entity_id });
    if (line.type === "payment" && line.order_id !== null) {
      refs.push({ kind: "order", id: line.order_id });
    }
  }
  if (bankTxnId !== undefined) refs.push({ kind: "bank_txn", id: bankTxnId });
  return refs;
}

function nearbyBankCandidates(
  bank: readonly NormalizedBankTxn[],
  target: number,
): Candidate[] {
  return bank
    .filter((row) => Math.abs(row.credit_paise - target) <= CANDIDATE_WINDOW_PAISE)
    .sort(
      (a, b) =>
        Math.abs(a.credit_paise - target) - Math.abs(b.credit_paise - target) ||
        a.bank_txn_id.localeCompare(b.bank_txn_id),
    )
    .slice(0, 5)
    .map<Candidate>((row) => ({
      kind: "bank_txn",
      id: row.bank_txn_id,
      reason: "bank credit close to the expected net but carrying a different UTR",
      evidence: {
        credit_paise: row.credit_paise,
        delta_paise: row.credit_paise - target,
        utr: row.utr,
        value_date: row.value_date,
      },
    }));
}

export function matchSettlementsToBank(
  lines: readonly NormalizedLine[],
  bank: readonly NormalizedBankTxn[],
): SettlementBankResult {
  const findings: Finding[] = [];
  const groups = groupSettlements(lines);

  const bankByUtr = new Map<string, NormalizedBankTxn[]>();
  for (const row of bank) {
    const bucket = bankByUtr.get(row.utr);
    if (bucket) bucket.push(row);
    else bankByUtr.set(row.utr, [row]);
  }

  const bankBySettlement = new Map<string, NormalizedBankTxn>();
  const matchedSettlementIds = new Set<string>();
  const matchedBankIds = new Set<string>();
  const claimedBankIds = new Set<string>();

  for (const group of groups) {
    const hits = [...(bankByUtr.get(group.utr) ?? [])].sort((a, b) =>
      a.bank_txn_id.localeCompare(b.bank_txn_id),
    );
    for (const hit of hits) claimedBankIds.add(hit.bank_txn_id);

    const baseEvidence = {
      settlement_status: group.status,
      expected_net_paise: group.expected_net_paise,
      stated_net_paise: group.stated_net_paise,
      utr: group.utr,
      settled_at: group.settled_at,
      line_count: group.lines.length,
    };

    if (group.status === "on_hold") {
      const unexpected = hits[0];
      if (unexpected !== undefined) {
        findings.push({
          code: "UNEXPECTED_BANK_CREDIT_ON_HOLD",
          entities: ownedBySettlement(group, unexpected.bank_txn_id),
          evidence: {
            ...baseEvidence,
            bank_txn_id: unexpected.bank_txn_id,
            bank_credit_paise: unexpected.credit_paise,
            note: "settlement is on hold but the bank shows a credit for its UTR",
          },
          candidates: [],
        });
      } else {
        // Held money is money the merchant has not received. It cannot be
        // called reconciled, so it goes to residue with its whole batch.
        findings.push({
          code: "SETTLEMENT_ON_HOLD",
          entities: ownedBySettlement(group),
          evidence: {
            ...baseEvidence,
            bank_rows_for_utr: 0,
            withheld_paise: group.expected_net_paise,
          },
          candidates: nearbyBankCandidates(bank, group.expected_net_paise),
        });
      }
      continue;
    }

    if (hits.length === 0) {
      findings.push({
        code: "SETTLEMENT_WITHOUT_BANK_CREDIT",
        entities: ownedBySettlement(group),
        evidence: { ...baseEvidence, bank_rows_for_utr: 0 },
        candidates: nearbyBankCandidates(bank, group.expected_net_paise),
      });
      continue;
    }

    const row = hits[0] as NormalizedBankTxn;
    const delta = row.credit_paise - group.expected_net_paise;
    if (Math.abs(delta) > NET_TOLERANCE_PAISE || group.stated_net_paise !== group.expected_net_paise) {
      findings.push({
        code: "NET_MISMATCH",
        entities: ownedBySettlement(group, row.bank_txn_id),
        evidence: {
          ...baseEvidence,
          bank_txn_id: row.bank_txn_id,
          bank_credit_paise: row.credit_paise,
          delta_paise: delta,
          header_vs_lines_delta_paise: group.stated_net_paise - group.expected_net_paise,
          tolerance_paise: NET_TOLERANCE_PAISE,
        },
        candidates: [],
      });
      continue;
    }

    bankBySettlement.set(group.settlement_id, row);
    matchedSettlementIds.add(group.settlement_id);
    matchedBankIds.add(row.bank_txn_id);
  }

  const settlementsByNet = new Map<number, SettlementGroup[]>();
  for (const group of groups) {
    const bucket = settlementsByNet.get(group.expected_net_paise);
    if (bucket) bucket.push(group);
    else settlementsByNet.set(group.expected_net_paise, [group]);
  }

  for (const row of bank) {
    if (claimedBankIds.has(row.bank_txn_id)) continue;
    findings.push({
      code: "BANK_CREDIT_WITHOUT_SETTLEMENT",
      entities: [{ kind: "bank_txn", id: row.bank_txn_id }],
      evidence: {
        utr: row.utr,
        description: row.description,
        description_format: row.description_format,
        credit_paise: row.credit_paise,
        value_date: row.value_date,
        settlements_carrying_this_utr: 0,
      },
      candidates: groups
        .filter(
          (group) => Math.abs(group.expected_net_paise - row.credit_paise) <= CANDIDATE_WINDOW_PAISE,
        )
        .sort(
          (a, b) =>
            Math.abs(a.expected_net_paise - row.credit_paise) -
              Math.abs(b.expected_net_paise - row.credit_paise) ||
            a.settlement_id.localeCompare(b.settlement_id),
        )
        .slice(0, 5)
        .map<Candidate>((group) => ({
          kind: "settlement",
          id: group.settlement_id,
          reason: "settlement whose net is close to this credit but whose UTR differs",
          evidence: {
            expected_net_paise: group.expected_net_paise,
            delta_paise: row.credit_paise - group.expected_net_paise,
            utr: group.utr,
            settled_at: group.settled_at,
          },
        })),
    });
  }

  return { findings, groups, bankBySettlement, matchedSettlementIds, matchedBankIds };
}
