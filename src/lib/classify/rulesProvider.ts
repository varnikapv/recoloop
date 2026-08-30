/**
 * A deterministic, offline baseline classifier.
 *
 * Two jobs. It lets the whole harness — retries, gating, resume, scoring — be
 * exercised end to end without an API key or a single token spent. And it is an
 * honest baseline: it is the best a hand-written lookup from finding code to
 * cause can do, so it measures exactly how much the model layer is adding.
 *
 * It reads only finding_types and evidence. It never sees labels.json.
 */
import type { ResidueEntry } from "../match/types";
import { CONFIDENCE_THRESHOLD } from "./config";
import { INSUFFICIENT_EVIDENCE, type Prediction } from "./schema";
import type { ClassifyCall, Provider } from "./provider";

interface Verdict {
  cause: Prediction;
  confidence: number;
  reasoning: string;
  action: string | null;
  amount_paise: number | null;
}

const num = (evidence: ResidueEntry["evidence"], key: string): number | null => {
  const value = evidence[key];
  return typeof value === "number" ? value : null;
};
const str = (evidence: ResidueEntry["evidence"], key: string): string | null => {
  const value = evidence[key];
  return typeof value === "string" ? value : null;
};

export function ruleVerdict(entry: ResidueEntry): Verdict {
  const codes = new Set(entry.finding_types);
  const evidence = entry.evidence;

  // Settlement-level first: a held batch outranks any single line inside it.
  if (codes.has("SETTLEMENT_ON_HOLD") || codes.has("UNEXPECTED_BANK_CREDIT_ON_HOLD")) {
    const withheld = num(evidence, "withheld_paise") ?? num(evidence, "expected_net_paise") ?? 0;
    return {
      cause: "ON_HOLD",
      confidence: 0.95,
      reasoning: `Settlement status is on_hold with 0 bank rows for its UTR; ${withheld} paise across ${num(evidence, "line_count") ?? 0} lines never reached the bank.`,
      action: "chase the gateway to release the held settlement; do not book revenue as received",
      amount_paise: withheld,
    };
  }

  if (codes.has("BANK_CREDIT_WITHOUT_SETTLEMENT")) {
    return {
      cause: "UNEXPLAINED",
      confidence: 0.9,
      reasoning: `Bank credit of ${num(evidence, "credit_paise") ?? 0} paise carries UTR ${str(evidence, "utr") ?? "?"}, which appears in no settlement in the report.`,
      action: "flag for dashboard follow-up — trace the UTR with the bank",
      amount_paise: num(evidence, "credit_paise"),
    };
  }

  if (codes.has("ORDER_STATUS_CONTRADICTION")) {
    return {
      cause: "SILENT_UPI_FAIL",
      confidence: 0.9,
      reasoning: `Order status is ${str(evidence, "order_status") ?? "?"} while ${num(evidence, "settled_amount_paise") ?? 0} paise settled against it in ${str(evidence, "settlement_id") ?? "?"}.`,
      action: "reconcile the order status to paid; no money movement required",
      amount_paise: null,
    };
  }

  if (codes.has("SHORT_CAPTURE")) {
    return {
      cause: "PARTIAL_CAPTURE",
      confidence: 0.9,
      reasoning: `Captured ${num(evidence, "captured_amount_paise") ?? 0} paise against an order of ${num(evidence, "order_amount_paise") ?? 0} paise, short by ${num(evidence, "shortfall_paise") ?? 0}.`,
      action: "book the shortfall against the order or void the uncaptured balance",
      amount_paise: num(evidence, "shortfall_paise"),
    };
  }

  if (codes.has("FEE_SLAB_MISMATCH")) {
    const delta = (num(evidence, "fee_delta_paise") ?? 0) + (num(evidence, "tax_delta_paise") ?? 0);
    return {
      cause: "FEE_VARIANCE",
      confidence: 0.9,
      reasoning: `Fee billed at ${num(evidence, "effective_bp") ?? 0}bp against a ${num(evidence, "slab_bp") ?? 0}bp slab: ${num(evidence, "actual_fee_paise") ?? 0} paise instead of ${num(evidence, "expected_fee_paise") ?? 0}.`,
      action: `book fee variance adjustment of ${delta} paise`,
      amount_paise: delta,
    };
  }

  if (codes.has("ORPHAN_SETTLEMENT_LINE")) {
    const lineType = str(evidence, "line_type");
    if (lineType === "adjustment") {
      return {
        cause: "CHARGEBACK_DEBIT",
        confidence: 0.9,
        reasoning: `Adjustment line debits ${num(evidence, "debit_paise") ?? 0} paise with no payment_id and no order_id anywhere in either source.`,
        action: "raise a chargeback dispute and provision the debit",
        amount_paise: num(evidence, "debit_paise"),
      };
    }
    if (lineType === "refund") {
      return {
        cause: "REFUND_NETTED",
        confidence: 0.9,
        reasoning: `Refund line debits ${num(evidence, "debit_paise") ?? 0} paise against ${str(evidence, "missing_payment_id") ?? "?"}, a payment that has no line in this report.`,
        action: "no action — refund of a prior-cycle payment, netted into this batch",
        amount_paise: null,
      };
    }
    return {
      cause: INSUFFICIENT_EVIDENCE,
      confidence: 0.3,
      reasoning: `Orphan settlement line of type ${lineType ?? "unknown"} with nothing to attach it to.`,
      action: null,
      amount_paise: null,
    };
  }

  if (codes.has("DUPLICATE_ORDER_PAIR")) {
    return {
      cause: "DUPLICATE_WEBHOOK",
      confidence: 0.85,
      reasoning: `${num(evidence, "orders_in_group") ?? 2} order rows share amount ${num(evidence, "amount_paise") ?? 0} paise ${num(evidence, "seconds_apart") ?? 0}s apart, and only ${num(evidence, "settled_orders") ?? 0} settled.`,
      action: "void the duplicate order row; revenue is overstated, no money is missing",
      amount_paise: null,
    };
  }

  if (codes.has("SETTLEMENT_DELAY")) {
    const delta = num(evidence, "day_delta") ?? 0;
    if (delta >= 4) {
      return {
        cause: "LATE_SETTLEMENT",
        confidence: 0.85,
        reasoning: `Settled at T+${delta} against an expected T+2 (${num(evidence, "excess_days") ?? 0} days late); the money did arrive, in a later batch.`,
        action: "no action — timing only",
        amount_paise: null,
      };
    }
    return {
      cause: INSUFFICIENT_EVIDENCE,
      confidence: 0.3,
      reasoning: `Day-delta is ${delta}, measured from order creation rather than capture; a T+3 reading is consistent with a normal T+2 settlement whose capture crossed midnight.`,
      action: "no action — likely normal T+2 settlement, not a defect",
      amount_paise: null,
    };
  }

  if (codes.has("ORDER_WITHOUT_SETTLEMENT")) {
    return {
      cause: INSUFFICIENT_EVIDENCE,
      confidence: 0.3,
      reasoning: "A paid order with no settlement line and no twin: no evidence positively supports any of the nine causes.",
      action: "flag for dashboard follow-up",
      amount_paise: null,
    };
  }

  return {
    cause: INSUFFICIENT_EVIDENCE,
    confidence: 0.2,
    reasoning: `No rule covers findings ${entry.finding_types.join(", ") || "(none)"}.`,
    action: null,
    amount_paise: null,
  };
}

export function createRulesProvider(entriesById: Map<string, ResidueEntry>): Provider {
  return {
    name: "rules-baseline",
    model: "deterministic-rules-v1",
    classify(call: ClassifyCall): Promise<unknown> {
      const match = /^CASE (\S+)/.exec(call.user);
      const id = match?.[1] ?? "";
      const entry = entriesById.get(id);
      if (entry === undefined) throw new Error(`rules provider: unknown case ${id}`);
      const verdict = ruleVerdict(entry);
      return Promise.resolve({
        residue_id: entry.residue_id,
        predicted_cause: verdict.cause,
        confidence: verdict.confidence,
        reasoning: verdict.reasoning,
        proposed_adjusting_entry:
          verdict.action === null
            ? null
            : { action: verdict.action, amount_paise: verdict.amount_paise },
        requires_human_review:
          verdict.confidence < CONFIDENCE_THRESHOLD || verdict.cause === INSUFFICIENT_EVIDENCE,
      });
    },
  };
}
