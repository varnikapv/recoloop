/**
 * Stage 1 — order to payment.
 *
 * Pure: (normalized records) -> findings. No I/O.
 */
import type { NormalizedLine, NormalizedOrder } from "../normalize";
import type { Candidate, EntityRef, ExcludedRecord, Finding } from "./types";

const DUPLICATE_WINDOW_MS = 90_000;

export interface OrderPaymentResult {
  findings: Finding[];
  /** order_id -> the payment line that settles it. */
  paymentLineByOrder: Map<string, NormalizedLine>;
  excluded: ExcludedRecord[];
}

/**
 * Two order rows with identical amounts, created within 90 seconds, are treated
 * as candidates for the SAME underlying payment. The matcher does not pick one:
 * both go to residue together and the ambiguity travels forward.
 */
function duplicateComponents(orders: readonly NormalizedOrder[]): NormalizedOrder[][] {
  const byAmount = new Map<number, NormalizedOrder[]>();
  for (const order of orders) {
    const bucket = byAmount.get(order.amount_paise);
    if (bucket) bucket.push(order);
    else byAmount.set(order.amount_paise, [order]);
  }

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = parent.get(id) ?? id;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
    let cursor = id;
    while (cursor !== root) {
      const next = parent.get(cursor) ?? cursor;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra, rb);
  };

  const paired = new Set<string>();
  for (const bucket of byAmount.values()) {
    if (bucket.length < 2) continue;
    const sorted = [...bucket].sort((a, b) =>
      a.created_ms === b.created_ms ? a.order_id.localeCompare(b.order_id) : a.created_ms - b.created_ms,
    );
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const left = sorted[i] as NormalizedOrder;
        const right = sorted[j] as NormalizedOrder;
        if (right.created_ms - left.created_ms > DUPLICATE_WINDOW_MS) break;
        union(left.order_id, right.order_id);
        paired.add(left.order_id);
        paired.add(right.order_id);
      }
    }
  }

  const byRoot = new Map<string, NormalizedOrder[]>();
  const index = new Map(orders.map((o) => [o.order_id, o]));
  for (const id of [...paired].sort()) {
    const root = find(id);
    const order = index.get(id);
    if (!order) continue;
    const group = byRoot.get(root);
    if (group) group.push(order);
    else byRoot.set(root, [order]);
  }
  return [...byRoot.values()]
    .map((group) => [...group].sort((a, b) => a.order_id.localeCompare(b.order_id)))
    .sort((a, b) => (a[0] as NormalizedOrder).order_id.localeCompare((b[0] as NormalizedOrder).order_id));
}

export function matchOrdersToPayments(
  orders: readonly NormalizedOrder[],
  lines: readonly NormalizedLine[],
): OrderPaymentResult {
  const findings: Finding[] = [];
  const excluded: ExcludedRecord[] = [];

  const paymentLineByOrder = new Map<string, NormalizedLine>();
  for (const line of lines) {
    if (line.type !== "payment" || line.order_id === null) continue;
    paymentLineByOrder.set(line.order_id, line);
  }

  const claimedByDuplicate = new Set<string>();
  for (const group of duplicateComponents(orders)) {
    const settled = group.filter((o) => paymentLineByOrder.has(o.order_id));
    const unsettled = group.filter((o) => !paymentLineByOrder.has(o.order_id));
    const first = group[0] as NormalizedOrder;
    const last = group[group.length - 1] as NormalizedOrder;

    const entities: EntityRef[] = group.map((o) => ({ kind: "order", id: o.order_id }));
    // The settled twin's line is part of the dispute: whether that money is one
    // payment or two is exactly the open question.
    for (const order of settled) {
      const line = paymentLineByOrder.get(order.order_id) as NormalizedLine;
      entities.push({ kind: "settlement_line", id: line.entity_id });
    }
    for (const order of group) claimedByDuplicate.add(order.order_id);

    findings.push({
      code: "DUPLICATE_ORDER_PAIR",
      entities,
      evidence: {
        order_ids: group.map((o) => o.order_id).join(","),
        amount_paise: first.amount_paise,
        seconds_apart: Math.round(Math.abs(last.created_ms - first.created_ms) / 1000),
        orders_in_group: group.length,
        settled_orders: settled.length,
        unsettled_orders: unsettled.length,
        distinct_settlement_lines: settled.length,
      },
      candidates: group.map<Candidate>((order) => ({
        kind: "order",
        id: order.order_id,
        reason: paymentLineByOrder.has(order.order_id)
          ? "twin with a settlement line — the surviving candidate"
          : "twin with no settlement line — the likely duplicate write",
        evidence: {
          created_at: order.created_at,
          amount_paise: order.amount_paise,
          status: order.status,
        },
      })),
    });

    // A twin with no settlement line is also, plainly, a paid order that never
    // settled. Both codes land on the same residue entry.
    for (const order of unsettled) {
      if (order.status !== "paid") continue;
      findings.push({
        code: "ORDER_WITHOUT_SETTLEMENT",
        entities: [{ kind: "order", id: order.order_id }],
        evidence: {
          order_status: order.status,
          amount_paise: order.amount_paise,
          created_at: order.created_at,
          duplicate_of: group
            .filter((o) => o.order_id !== order.order_id)
            .map((o) => o.order_id)
            .join(","),
        },
        candidates: [],
      });
    }
  }

  for (const order of orders) {
    const line = paymentLineByOrder.get(order.order_id);
    if (claimedByDuplicate.has(order.order_id)) continue;

    if (order.status === "paid" && line === undefined) {
      findings.push({
        code: "ORDER_WITHOUT_SETTLEMENT",
        entities: [{ kind: "order", id: order.order_id }],
        evidence: {
          order_status: order.status,
          amount_paise: order.amount_paise,
          created_at: order.created_at,
        },
        candidates: [],
      });
      continue;
    }

    if (order.status !== "paid" && line !== undefined) {
      // The gateway settled money for an order the merchant never marked paid.
      findings.push({
        code: "ORDER_STATUS_CONTRADICTION",
        entities: [
          { kind: "order", id: order.order_id },
          { kind: "settlement_line", id: line.entity_id },
        ],
        evidence: {
          order_status: order.status,
          settled_amount_paise: line.amount_paise,
          order_amount_paise: order.amount_paise,
          settlement_id: line.settlement_id,
          settled_at: line.settled_at,
          method: line.method ?? "",
        },
        candidates: [],
      });
      continue;
    }

    if (order.status !== "paid" && line === undefined) {
      excluded.push({
        order_id: order.order_id,
        reason: "NO_MONEY_MOVEMENT_EXPECTED",
        status: order.status,
        amount_paise: order.amount_paise,
      });
    }
  }

  return { findings, paymentLineByOrder, excluded };
}
