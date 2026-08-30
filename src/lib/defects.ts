import { DEFECT_CAUSES, type DefectCause } from "./types";

/** The canonical distribution, defined at a total of 40. */
export const BASE_DISTRIBUTION: ReadonlyArray<readonly [DefectCause, number]> = [
  ["LATE_SETTLEMENT", 7],
  ["REFUND_NETTED", 6],
  ["PARTIAL_CAPTURE", 5],
  ["FEE_VARIANCE", 5],
  ["ON_HOLD", 4],
  ["DUPLICATE_WEBHOOK", 4],
  ["SILENT_UPI_FAIL", 4],
  ["CHARGEBACK_DEBIT", 3],
  ["UNEXPLAINED", 2],
];

export const BASE_TOTAL = BASE_DISTRIBUTION.reduce((sum, [, n]) => sum + n, 0);

export const CAUSE_DESCRIPTION: Readonly<Record<DefectCause, string>> = {
  LATE_SETTLEMENT:
    "Payment captured inside the window but settled T+5 instead of T+2, so it lands in a batch two cycles away from where the merchant expects it.",
  REFUND_NETTED:
    "A refund belonging to a payment from a prior cycle is netted into this settlement; the refund line has no payment line to trace back to.",
  PARTIAL_CAPTURE:
    "The captured payment amount is less than the order amount, so order-to-settlement amount matching misses.",
  FEE_VARIANCE:
    "Fee was charged at a rate 0.4 percentage points off the method's slab, so reconstructing net from gross misses by a small delta.",
  ON_HOLD:
    "Settlement is on hold at the gateway: the settlement exists in the report but no money ever hits the bank.",
  DUPLICATE_WEBHOOK:
    "A duplicated webhook wrote the same payment into the order ledger twice under two order ids, same amount, seconds apart. Only one of them ever settles.",
  SILENT_UPI_FAIL:
    "Payment was captured and settled, but the merchant's order never flipped out of 'pending' - the success callback was lost.",
  CHARGEBACK_DEBIT:
    "An adjustment debit (chargeback) appears in the settlement with no matching entity in orders or payments.",
  UNEXPLAINED:
    "A bank credit whose UTR appears in no settlement at all.",
};

/**
 * Scale BASE_DISTRIBUTION to an arbitrary total using the largest-remainder
 * method. Deterministic: ties break on the fixed BASE_DISTRIBUTION order.
 */
export function planDistribution(total: number): Map<DefectCause, number> {
  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`--defects must be a non-negative integer, got ${total}`);
  }
  const exact = BASE_DISTRIBUTION.map(([cause, n]) => ({
    cause,
    value: (n * total) / BASE_TOTAL,
  }));
  const plan = new Map<DefectCause, number>();
  let assigned = 0;
  for (const { cause, value } of exact) {
    const floor = Math.floor(value);
    plan.set(cause, floor);
    assigned += floor;
  }
  const remainders = exact
    .map(({ cause, value }, index) => ({ cause, index, frac: value - Math.floor(value) }))
    .sort((a, b) => (b.frac - a.frac) || (a.index - b.index));
  let leftover = total - assigned;
  for (const { cause } of remainders) {
    if (leftover <= 0) break;
    plan.set(cause, (plan.get(cause) ?? 0) + 1);
    leftover--;
  }
  // Guarantee every cause key exists, in canonical order.
  const ordered = new Map<DefectCause, number>();
  for (const cause of DEFECT_CAUSES) ordered.set(cause, plan.get(cause) ?? 0);
  return ordered;
}
