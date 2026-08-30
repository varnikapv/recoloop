/**
 * Stage 4 — settlement date tolerance.
 *
 * Pure: (normalized records) -> findings. No I/O.
 *
 * T+2 is not treated as a hard match/no-match boundary. The actual day-delta is
 * computed for every settled line and travels forward as evidence, so a later
 * classifier can tell a genuinely late settlement from a line that merely sits
 * near the midnight boundary.
 *
 * captured_at is not published in any of the three sources. The only timestamp
 * available for a payment is its order's created_at, and capture follows order
 * creation within minutes — so the delta measured here is
 * settlement_date - order_date, and a line whose capture crossed midnight
 * relative to its order reads as 3 rather than 2. That is exactly the boundary
 * noise this stage is built to expose rather than hide.
 */
import type { NormalizedLine, NormalizedOrder } from "../normalize";
import type { Finding } from "./types";

const DAY_MS = 86_400_000;
export const EXPECTED_DAY_DELTA = 2;

const dayOf = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

export interface DelayResult {
  findings: Finding[];
  /** Every settled payment line's day-delta, for distribution reporting. */
  histogram: Record<string, number>;
}

export function checkSettlementDelay(
  orders: readonly NormalizedOrder[],
  lines: readonly NormalizedLine[],
): DelayResult {
  const findings: Finding[] = [];
  const histogram: Record<string, number> = {};
  const orderById = new Map(orders.map((o) => [o.order_id, o]));

  for (const line of lines) {
    if (line.type !== "payment" || line.order_id === null) continue;
    const order = orderById.get(line.order_id);
    if (order === undefined) continue; // already an ORPHAN_SETTLEMENT_LINE in stage 2

    const delta = Math.round((dayOf(line.settled_at) - dayOf(order.created_at)) / DAY_MS);
    const key = String(delta);
    histogram[key] = (histogram[key] ?? 0) + 1;
    if (delta <= EXPECTED_DAY_DELTA) continue;

    findings.push({
      code: "SETTLEMENT_DELAY",
      entities: [
        { kind: "order", id: order.order_id },
        { kind: "settlement_line", id: line.entity_id },
      ],
      evidence: {
        day_delta: delta,
        expected_day_delta: EXPECTED_DAY_DELTA,
        excess_days: delta - EXPECTED_DAY_DELTA,
        order_created_at: order.created_at,
        settled_at: line.settled_at,
        settlement_id: line.settlement_id,
        amount_paise: line.amount_paise,
        method: line.method ?? "",
      },
      candidates: [],
    });
  }

  const ordered: Record<string, number> = {};
  for (const key of Object.keys(histogram).sort((a, b) => Number(a) - Number(b))) {
    ordered[key] = histogram[key] as number;
  }
  return { findings, histogram: ordered };
}
