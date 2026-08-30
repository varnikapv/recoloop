/**
 * Stage 2 — settlement lines to payments / refunds.
 *
 * Pure: (normalized records) -> findings. No I/O.
 *
 * The dataset ships no payments.csv: the payment and refund universe IS the
 * settlement report. So "resolves to no payment and no refund" is evaluated as
 * "has no counterpart in the merchant's own records":
 *
 *   payment line    -> its order_id must exist in orders.csv
 *   refund line     -> its payment_id must have a payment line in the report
 *   adjustment line -> has neither, and is always orphaned
 */
import type { NormalizedLine, NormalizedOrder } from "../normalize";
import type { Candidate, Finding } from "./types";

/**
 * The published fee slabs, in basis points. Restated here rather than imported
 * from the generator: the whole point of the check is to catch a fee that does
 * not follow the published rate.
 */
const PUBLISHED_FEE_BP: Readonly<Record<string, number>> = {
  upi: 0,
  card: 200,
  netbanking: 180,
  wallet: 220,
};
const GST_PERCENT = 18;

export function expectedFeePaise(amountPaise: number, method: string): number {
  const bp = PUBLISHED_FEE_BP[method];
  if (bp === undefined) throw new Error(`unknown payment method: ${JSON.stringify(method)}`);
  return Math.round((amountPaise * bp) / 10_000);
}

export function expectedTaxPaise(feePaise: number): number {
  return Math.round((feePaise * GST_PERCENT) / 100);
}

export interface PaymentSettlementResult {
  findings: Finding[];
  /** entity_id of every line that carries a line-level finding. */
  taintedLineIds: Set<string>;
}

export function matchLinesToEntities(
  orders: readonly NormalizedOrder[],
  lines: readonly NormalizedLine[],
): PaymentSettlementResult {
  const findings: Finding[] = [];
  const orderById = new Map(orders.map((o) => [o.order_id, o]));
  const paymentLineIds = new Set(
    lines.filter((l) => l.type === "payment").map((l) => l.entity_id),
  );
  const paymentLinesByAmount = new Map<number, NormalizedLine[]>();
  for (const line of lines) {
    if (line.type !== "payment") continue;
    const bucket = paymentLinesByAmount.get(line.amount_paise);
    if (bucket) bucket.push(line);
    else paymentLinesByAmount.set(line.amount_paise, [line]);
  }

  for (const line of lines) {
    if (line.type === "adjustment") {
      findings.push({
        code: "ORPHAN_SETTLEMENT_LINE",
        entities: [{ kind: "settlement_line", id: line.entity_id }],
        evidence: {
          line_type: line.type,
          debit_paise: line.debit_paise,
          credit_paise: line.credit_paise,
          amount_paise: line.amount_paise,
          settlement_id: line.settlement_id,
          settled_at: line.settled_at,
          resolves_to: "neither an order nor a payment in the merchant's records",
        },
        candidates: [],
      });
      continue;
    }

    if (line.type === "refund") {
      const parent = line.payment_id;
      if (parent !== null && paymentLineIds.has(parent)) continue; // traceable refund
      findings.push({
        code: "ORPHAN_SETTLEMENT_LINE",
        entities: [{ kind: "settlement_line", id: line.entity_id }],
        evidence: {
          line_type: line.type,
          debit_paise: line.debit_paise,
          credit_paise: line.credit_paise,
          amount_paise: line.amount_paise,
          settlement_id: line.settlement_id,
          settled_at: line.settled_at,
          missing_payment_id: parent ?? "",
          missing_order_id: line.order_id ?? "",
          order_known_to_merchant: line.order_id !== null && orderById.has(line.order_id) ? 1 : 0,
          resolves_to: "no payment line anywhere in this settlement report",
        },
        // Near misses: payments of the same gross that could plausibly be the
        // parent this refund is missing.
        candidates: (paymentLinesByAmount.get(line.amount_paise) ?? [])
          .slice(0, 5)
          .map<Candidate>((candidate) => ({
            kind: "settlement_line",
            id: candidate.entity_id,
            reason: "payment line with an identical gross amount — possible parent",
            evidence: {
              amount_paise: candidate.amount_paise,
              settlement_id: candidate.settlement_id,
              settled_at: candidate.settled_at,
              order_id: candidate.order_id ?? "",
            },
          })),
      });
      continue;
    }

    // payment line
    const order = line.order_id === null ? undefined : orderById.get(line.order_id);
    if (order === undefined) {
      findings.push({
        code: "ORPHAN_SETTLEMENT_LINE",
        entities: [{ kind: "settlement_line", id: line.entity_id }],
        evidence: {
          line_type: line.type,
          debit_paise: line.debit_paise,
          credit_paise: line.credit_paise,
          amount_paise: line.amount_paise,
          settlement_id: line.settlement_id,
          settled_at: line.settled_at,
          missing_order_id: line.order_id ?? "",
          resolves_to: "no order in the merchant's ledger",
        },
        candidates: [],
      });
      continue;
    }

    if (line.amount_paise < order.amount_paise) {
      findings.push({
        code: "SHORT_CAPTURE",
        entities: [
          { kind: "order", id: order.order_id },
          { kind: "settlement_line", id: line.entity_id },
        ],
        evidence: {
          order_amount_paise: order.amount_paise,
          captured_amount_paise: line.amount_paise,
          shortfall_paise: order.amount_paise - line.amount_paise,
          shortfall_pct: Math.round(
            ((order.amount_paise - line.amount_paise) * 10_000) / order.amount_paise,
          ) / 100,
          settlement_id: line.settlement_id,
        },
        candidates: [],
      });
      continue;
    }

    if (line.method !== null) {
      const fee = expectedFeePaise(line.amount_paise, line.method);
      const tax = expectedTaxPaise(fee);
      if (fee !== line.fee_paise || tax !== line.tax_paise) {
        const bp = PUBLISHED_FEE_BP[line.method] ?? 0;
        findings.push({
          code: "FEE_SLAB_MISMATCH",
          entities: [
            { kind: "order", id: order.order_id },
            { kind: "settlement_line", id: line.entity_id },
          ],
          evidence: {
            method: line.method,
            amount_paise: line.amount_paise,
            slab_bp: bp,
            expected_fee_paise: fee,
            actual_fee_paise: line.fee_paise,
            fee_delta_paise: line.fee_paise - fee,
            expected_tax_paise: tax,
            actual_tax_paise: line.tax_paise,
            tax_delta_paise: line.tax_paise - tax,
            effective_bp:
              line.amount_paise === 0
                ? 0
                : Math.round((line.fee_paise * 10_000_00) / line.amount_paise) / 100,
            settlement_id: line.settlement_id,
          },
          candidates: [],
        });
      }
    }
  }

  return {
    findings,
    taintedLineIds: new Set(
      findings.flatMap((f) =>
        f.entities.filter((e) => e.kind === "settlement_line").map((e) => e.id),
      ),
    ),
  };
}
