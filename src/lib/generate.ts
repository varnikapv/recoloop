import {
  DAY_MS,
  SETTLEMENT_TIME_MS,
  addDays,
  dayStartUtc,
  fromIso,
  toIso,
  toIsoDate,
} from "./dates";
import { planDistribution } from "./defects";
import { bankTxnId, gatewayId, utr as makeUtr } from "./ids";
import { FEE_VARIANCE_BP, METHOD_FEE_BP, feePaise, taxPaise } from "./money";
import { type Rng, chance, gaussian, mulberry32, pick, randInt, shuffled, weighted } from "./rng";
import type {
  BankTxn,
  Dataset,
  DefectCause,
  DefectLabel,
  Order,
  OrderStatus,
  Payment,
  PaymentMethod,
  Refund,
  Settlement,
  SettlementLine,
} from "./types";

/** Fixed anchor so a seed pins the calendar too. 30-day window, UTC. */
export const WINDOW_START_MS = Date.UTC(2025, 4, 1, 0, 0, 0);
export const WINDOW_DAYS = 30;
export const WINDOW_END_MS = WINDOW_START_MS + WINDOW_DAYS * DAY_MS;

export const OPENING_BALANCE_PAISE = 25_000_000; // Rs 2,50,000

const MIN_AMOUNT_PAISE = 9_900; // Rs 99
const MAX_AMOUNT_PAISE = 8_500_000; // Rs 85,000

const METHOD_MIX: ReadonlyArray<readonly [PaymentMethod, number]> = [
  ["upi", 62],
  ["card", 24],
  ["netbanking", 9],
  ["wallet", 5],
];

const ORDER_STATUS_MIX: ReadonlyArray<readonly [OrderStatus, number]> = [
  ["paid", 90],
  ["pending", 6],
  ["cancelled", 4],
];

const BANK_DESCRIPTIONS: ReadonlyArray<(u: string) => string> = [
  (u) => `RAZORPAY SETTLEMENT ${u}`,
  (u) => `NEFT CR-${u}-RAZORPAY SOFTWARE PVT LTD`,
  (u) => `IMPS/${u}/RAZORPAYSOFT`,
];

export interface GenerateOptions {
  seed: number;
  orders: number;
  defects: number;
}

export interface GenerateResult {
  dataset: Dataset;
  plan: Map<DefectCause, number>;
  options: GenerateOptions;
}

interface PendingLine {
  /** UTC midnight of the settlement calendar day this line belongs to. */
  dayMs: number;
  line: SettlementLine;
}

function logNormalAmountPaise(rng: Rng): number {
  const rupees = Math.exp(Math.log(700) + 1.4 * gaussian(rng));
  const clampedRupees = Math.min(85_000, Math.max(99, rupees));
  const paise = chance(rng, 0.7)
    ? Math.round(clampedRupees) * 100
    : Math.round(clampedRupees * 100);
  return Math.min(MAX_AMOUNT_PAISE, Math.max(MIN_AMOUNT_PAISE, paise));
}

/** Second-precision timestamp uniformly inside the window. */
function randomWindowMs(rng: Rng): number {
  const span = WINDOW_END_MS - WINDOW_START_MS;
  return WINDOW_START_MS + Math.floor(rng() * span / 1000) * 1000;
}

function feeBpFor(method: PaymentMethod): number {
  const bp = METHOD_FEE_BP[method];
  if (bp === undefined) throw new Error(`no fee slab for method ${method}`);
  return bp;
}

function paymentCredit(p: Payment): number {
  return p.amount_paise - p.fee_paise - p.tax_paise;
}

function netOf(lines: readonly SettlementLine[]): number {
  let net = 0;
  for (const line of lines) net += line.credit_paise - line.debit_paise;
  return net;
}

export function generateDataset(options: GenerateOptions): GenerateResult {
  const { seed, orders: orderCount, defects: defectCount } = options;
  if (!Number.isInteger(orderCount) || orderCount < 1) {
    throw new Error(`--orders must be a positive integer, got ${orderCount}`);
  }
  const rng = mulberry32(seed);
  const plan = planDistribution(defectCount);
  const labels: DefectLabel[] = [];
  const claimed = new Set<string>();

  // ---------------------------------------------------------------- orders
  const orders: Order[] = [];
  const payments: Payment[] = [];
  const paymentsByOrder = new Map<string, Payment>();

  for (let i = 0; i < orderCount; i++) {
    const createdMs = randomWindowMs(rng);
    const amount = logNormalAmountPaise(rng);
    const status = weighted(rng, ORDER_STATUS_MIX);
    const order: Order = {
      order_id: gatewayId(rng, "order_"),
      amount_paise: amount,
      currency: "INR",
      created_at: toIso(createdMs),
      status,
    };
    orders.push(order);

    const method = weighted(rng, METHOD_MIX);
    const capturedMs = createdMs + randInt(rng, 5, 1800) * 1000;

    if (status === "paid") {
      const bp = feeBpFor(method);
      const fee = feePaise(amount, bp);
      const payment: Payment = {
        payment_id: gatewayId(rng, "pay_"),
        order_id: order.order_id,
        amount_paise: amount,
        fee_paise: fee,
        tax_paise: taxPaise(fee),
        method,
        status: "captured",
        captured_at: toIso(capturedMs),
      };
      payments.push(payment);
      paymentsByOrder.set(order.order_id, payment);
    } else if (status === "pending" && chance(rng, 0.5)) {
      const payment: Payment = {
        payment_id: gatewayId(rng, "pay_"),
        order_id: order.order_id,
        amount_paise: amount,
        fee_paise: 0,
        tax_paise: 0,
        method,
        status: "authorized",
        captured_at: toIso(capturedMs),
      };
      payments.push(payment);
      paymentsByOrder.set(order.order_id, payment);
    } else if (status === "cancelled" && chance(rng, 0.4)) {
      const payment: Payment = {
        payment_id: gatewayId(rng, "pay_"),
        order_id: order.order_id,
        amount_paise: amount,
        fee_paise: 0,
        tax_paise: 0,
        method,
        status: "failed",
        captured_at: toIso(capturedMs),
      };
      payments.push(payment);
      paymentsByOrder.set(order.order_id, payment);
    }
  }

  const orderById = new Map(orders.map((o) => [o.order_id, o]));
  const paymentById = new Map(payments.map((p) => [p.payment_id, p]));

  // --------------------------------------------------------------- refunds
  //
  // A settlement is a net of that day's credits and debits, and a real batch is
  // never a net debit. So the size of a refund that can be netted is bounded by
  // the size of a day's gross credits: we cap debits at half the median daily
  // gross, which excludes only the largest tickets from the refund pool.
  const grossByDay = new Map<number, number>();
  for (const payment of payments) {
    if (payment.status !== "captured") continue;
    const day = addDays(dayStartUtc(fromIso(payment.captured_at)), 2);
    grossByDay.set(day, (grossByDay.get(day) ?? 0) + paymentCredit(payment));
  }
  const dailyGross = [...grossByDay.values()].sort((a, b) => a - b);
  const medianDailyGross = dailyGross.length === 0
    ? 0
    : (dailyGross[Math.floor((dailyGross.length - 1) / 2)] as number);
  const debitCapPaise = Math.max(10_000, Math.floor(medianDailyGross / 2));

  const refunds: Refund[] = [];
  const refundsByPayment = new Map<string, Refund[]>();
  const capturedPayments = payments.filter(
    (p) => p.status === "captured" && p.amount_paise <= debitCapPaise,
  );

  for (const payment of capturedPayments) {
    if (!chance(rng, 0.04)) continue;
    const capturedMs = fromIso(payment.captured_at);
    const createdMs =
      capturedMs + randInt(rng, 1, 9) * DAY_MS + randInt(rng, 0, 86_399) * 1000;
    const full = chance(rng, 0.6);
    const amount = full
      ? payment.amount_paise
      : Math.max(100, Math.round((payment.amount_paise * randInt(rng, 20, 80)) / 100));
    const refund: Refund = {
      refund_id: gatewayId(rng, "rfnd_"),
      payment_id: payment.payment_id,
      amount_paise: amount,
      created_at: toIso(createdMs),
    };
    refunds.push(refund);
    refundsByPayment.set(payment.payment_id, [
      ...(refundsByPayment.get(payment.payment_id) ?? []),
      refund,
    ]);
    if (full) payment.status = "refunded";
  }

  // ------------------------------------------------------- defect selection
  const settling = payments.filter(
    (p) => p.status === "captured" || p.status === "refunded",
  );
  const unrefunded = settling.filter((p) => !refundsByPayment.has(p.payment_id));

  const takeTargets = <T>(
    poolBuilder: () => T[],
    count: number,
    idsOf: (item: T) => string[],
    cause: DefectCause,
  ): T[] => {
    if (count === 0) return [];
    const pool = poolBuilder().filter((item) => idsOf(item).every((id) => !claimed.has(id)));
    if (pool.length < count) {
      throw new Error(
        `not enough eligible records for ${cause}: need ${count}, have ${pool.length}. ` +
          "Increase --orders or lower --defects.",
      );
    }
    const chosen = shuffled(rng, pool).slice(0, count);
    for (const item of chosen) for (const id of idsOf(item)) claimed.add(id);
    return chosen;
  };

  const need = (cause: DefectCause): number => plan.get(cause) ?? 0;

  // SILENT_UPI_FAIL - most constrained pool, selected first.
  const lateSettlement = new Set<string>();
  for (const payment of takeTargets(
    () =>
      unrefunded.filter(
        (p) => p.method === "upi" && orderById.get(p.order_id)?.status === "paid",
      ),
    need("SILENT_UPI_FAIL"),
    (p) => [p.payment_id, p.order_id],
    "SILENT_UPI_FAIL",
  )) {
    const order = orderById.get(payment.order_id);
    if (!order) throw new Error(`missing order ${payment.order_id}`);
    order.status = "pending";
    labels.push({
      record_type: "order",
      record_id: order.order_id,
      true_cause: "SILENT_UPI_FAIL",
      note: `Order left in 'pending' although ${payment.payment_id} was captured for ${payment.amount_paise} paise and settled.`,
    });
  }

  // PARTIAL_CAPTURE
  for (const payment of takeTargets(
    () => unrefunded.filter((p) => orderById.get(p.order_id)?.status === "paid"),
    need("PARTIAL_CAPTURE"),
    (p) => [p.payment_id, p.order_id],
    "PARTIAL_CAPTURE",
  )) {
    const order = orderById.get(payment.order_id);
    if (!order) throw new Error(`missing order ${payment.order_id}`);
    const captured = Math.max(
      100,
      Math.round((order.amount_paise * randInt(rng, 50, 92)) / 100),
    );
    payment.amount_paise = captured;
    const fee = feePaise(captured, feeBpFor(payment.method));
    payment.fee_paise = fee;
    payment.tax_paise = taxPaise(fee);
    labels.push({
      record_type: "payment",
      record_id: payment.payment_id,
      true_cause: "PARTIAL_CAPTURE",
      note: `Captured ${captured} paise against order ${order.order_id} of ${order.amount_paise} paise (short by ${order.amount_paise - captured}).`,
    });
  }

  // DUPLICATE_WEBHOOK - clones an order row; the clone never settles.
  for (const source of takeTargets(
    () => orders.filter((o) => o.status === "paid" && paymentsByOrder.has(o.order_id)),
    need("DUPLICATE_WEBHOOK"),
    (o) => [o.order_id],
    "DUPLICATE_WEBHOOK",
  )) {
    const offsetSeconds = randInt(rng, 1, 89) * (chance(rng, 0.5) ? 1 : -1);
    const duplicate: Order = {
      order_id: gatewayId(rng, "order_"),
      amount_paise: source.amount_paise,
      currency: "INR",
      created_at: toIso(fromIso(source.created_at) + offsetSeconds * 1000),
      status: source.status,
    };
    orders.push(duplicate);
    orderById.set(duplicate.order_id, duplicate);
    claimed.add(duplicate.order_id);
    labels.push({
      record_type: "order",
      record_id: duplicate.order_id,
      true_cause: "DUPLICATE_WEBHOOK",
      note: `Duplicate of order ${source.order_id}: same amount ${source.amount_paise} paise, created ${Math.abs(offsetSeconds)}s apart. Only ${source.order_id} has a settlement line.`,
    });
  }

  // LATE_SETTLEMENT
  for (const payment of takeTargets(
    () => settling,
    need("LATE_SETTLEMENT"),
    (p) => [p.payment_id, p.order_id],
    "LATE_SETTLEMENT",
  )) {
    lateSettlement.add(payment.payment_id);
    labels.push({
      record_type: "payment",
      record_id: payment.payment_id,
      true_cause: "LATE_SETTLEMENT",
      note: `Captured ${payment.captured_at} but settled on T+5 instead of T+2, landing outside its expected batch.`,
    });
  }

  // FEE_VARIANCE
  for (const payment of takeTargets(
    () => settling,
    need("FEE_VARIANCE"),
    (p) => [p.payment_id, p.order_id],
    "FEE_VARIANCE",
  )) {
    const slab = feeBpFor(payment.method);
    const direction = slab === 0 ? 1 : chance(rng, 0.5) ? 1 : -1;
    const appliedBp = slab + direction * FEE_VARIANCE_BP;
    const expected = payment.fee_paise;
    const fee = feePaise(payment.amount_paise, appliedBp);
    payment.fee_paise = fee;
    payment.tax_paise = taxPaise(fee);
    labels.push({
      record_type: "payment",
      record_id: payment.payment_id,
      true_cause: "FEE_VARIANCE",
      note: `Fee billed at ${(appliedBp / 100).toFixed(2)}% instead of the ${(slab / 100).toFixed(2)}% ${payment.method} slab: ${fee} paise instead of ${expected}.`,
    });
  }

  // ------------------------------------------------------ settlement lines
  const paymentLines: PendingLine[] = [];
  const debitLines: PendingLine[] = [];

  const blankLine = (
    entityId: string,
    type: SettlementLine["type"],
    fields: Partial<SettlementLine>,
  ): SettlementLine => ({
    entity_id: entityId,
    type,
    debit_paise: 0,
    credit_paise: 0,
    amount_paise: 0,
    fee_paise: 0,
    tax_paise: 0,
    settlement_id: "",
    settled_at: "",
    order_id: null,
    payment_id: null,
    method: null,
    ...fields,
  });

  for (const payment of settling) {
    const lagDays = lateSettlement.has(payment.payment_id) ? 5 : 2;
    const dayMs = addDays(dayStartUtc(fromIso(payment.captured_at)), lagDays);
    paymentLines.push({
      dayMs,
      line: blankLine(payment.payment_id, "payment", {
        credit_paise: paymentCredit(payment),
        amount_paise: payment.amount_paise,
        fee_paise: payment.fee_paise,
        tax_paise: payment.tax_paise,
        order_id: payment.order_id,
        payment_id: payment.payment_id,
        method: payment.method,
      }),
    });
  }

  for (const refund of refunds) {
    const payment = paymentById.get(refund.payment_id);
    if (!payment) throw new Error(`missing payment ${refund.payment_id}`);
    debitLines.push({
      dayMs: addDays(dayStartUtc(fromIso(refund.created_at)), 2),
      line: blankLine(refund.refund_id, "refund", {
        debit_paise: refund.amount_paise,
        amount_paise: refund.amount_paise,
        order_id: payment.order_id,
        payment_id: payment.payment_id,
      }),
    });
  }

  // REFUND_NETTED - refunds against payments captured before this window, so
  // the refund line has no payment line anywhere in the report.
  for (let i = 0; i < need("REFUND_NETTED"); i++) {
    const createdMs = randomWindowMs(rng);
    const amount = Math.min(logNormalAmountPaise(rng), debitCapPaise);
    const refund: Refund = {
      refund_id: gatewayId(rng, "rfnd_"),
      payment_id: gatewayId(rng, "pay_"),
      amount_paise: amount,
      created_at: toIso(createdMs),
    };
    const priorOrderId = gatewayId(rng, "order_");
    refunds.push(refund);
    debitLines.push({
      dayMs: addDays(dayStartUtc(createdMs), 2),
      line: blankLine(refund.refund_id, "refund", {
        debit_paise: amount,
        amount_paise: amount,
        order_id: priorOrderId,
        payment_id: refund.payment_id,
      }),
    });
    labels.push({
      record_type: "refund",
      record_id: refund.refund_id,
      true_cause: "REFUND_NETTED",
      note: `Refund of ${amount} paise against ${refund.payment_id}, a payment settled in a prior cycle. Neither that payment nor order ${priorOrderId} exists in this dataset.`,
    });
  }

  // CHARGEBACK_DEBIT
  for (let i = 0; i < need("CHARGEBACK_DEBIT"); i++) {
    const createdMs = randomWindowMs(rng);
    const amount = Math.min(randInt(rng, 500, 15_000) * 100, debitCapPaise);
    const entityId = gatewayId(rng, "adj_");
    debitLines.push({
      dayMs: addDays(dayStartUtc(createdMs), 2),
      line: blankLine(entityId, "adjustment", {
        debit_paise: amount,
        amount_paise: amount,
      }),
    });
    labels.push({
      record_type: "settlement_line",
      record_id: entityId,
      true_cause: "CHARGEBACK_DEBIT",
      note: `Adjustment debit of ${amount} paise with no corresponding order or payment in either source.`,
    });
  }

  // ------------------------------------------------- batching into settlements
  const buckets = new Map<number, SettlementLine[]>();
  for (const { dayMs, line } of paymentLines) {
    const bucket = buckets.get(dayMs);
    if (bucket) bucket.push(line);
    else buckets.set(dayMs, [line]);
  }
  const creditDays = [...buckets.keys()].sort((a, b) => a - b);
  if (creditDays.length === 0) {
    throw new Error("no settling payments were generated; increase --orders");
  }
  const lastCreditDay = creditDays[creditDays.length - 1] as number;

  // A debit joins the first settlement on or after its own T+2 day.
  for (const { dayMs, line } of debitLines) {
    const target = creditDays.find((d) => d >= dayMs) ?? lastCreditDay;
    (buckets.get(target) as SettlementLine[]).push(line);
  }

  // A settlement is never a net debit. Sweep the days forward once, carrying any
  // debit a batch cannot absorb into the next batch - which is what a gateway
  // actually does when a day's refunds outrun its captures.
  const largestDebitIndex = (lines: readonly SettlementLine[]): number => {
    let worst = -1;
    for (let k = 0; k < lines.length; k++) {
      const candidate = lines[k] as SettlementLine;
      if (candidate.debit_paise <= 0) continue;
      if (worst < 0 || candidate.debit_paise > (lines[worst] as SettlementLine).debit_paise) {
        worst = k;
      }
    }
    return worst;
  };

  const carried: SettlementLine[] = [];
  for (const day of creditDays) {
    const lines = buckets.get(day) as SettlementLine[];
    lines.push(...carried.splice(0, carried.length));
    for (;;) {
      if (netOf(lines) > 0) break;
      const worst = largestDebitIndex(lines);
      if (worst < 0) break; // credit-only batch: already positive
      carried.push(...lines.splice(worst, 1));
    }
  }

  // Anything still carried past the final batch goes into the roomiest batch
  // that can still absorb it.
  for (const line of carried) {
    let bestDay: number | null = null;
    let bestNet = 0;
    for (const day of creditDays) {
      const net = netOf(buckets.get(day) as SettlementLine[]);
      if (net - line.debit_paise > 0 && net > bestNet) {
        bestDay = day;
        bestNet = net;
      }
    }
    if (bestDay === null) {
      throw new Error(
        `debit ${line.entity_id} of ${line.debit_paise} paise exceeds the gross credit of every ` +
          "settlement in the window; increase --orders so daily volume can absorb it.",
      );
    }
    (buckets.get(bestDay) as SettlementLine[]).push(line);
  }

  const settlements: Settlement[] = [];
  const lines: SettlementLine[] = [];
  const usedUtrs = new Set<string>();
  const nextUtr = (): string => {
    for (;;) {
      const candidate = makeUtr(rng);
      if (!usedUtrs.has(candidate)) {
        usedUtrs.add(candidate);
        return candidate;
      }
    }
  };

  for (const day of creditDays) {
    const bucket = buckets.get(day) as SettlementLine[];
    if (bucket.length === 0) continue;
    const settlementId = gatewayId(rng, "setl_");
    const settledAt = toIso(day + SETTLEMENT_TIME_MS);
    let fee = 0;
    let tax = 0;
    for (const line of bucket) {
      line.settlement_id = settlementId;
      line.settled_at = settledAt;
      fee += line.fee_paise;
      tax += line.tax_paise;
      lines.push(line);
    }
    settlements.push({
      settlement_id: settlementId,
      net_amount_paise: netOf(bucket),
      fee_paise: fee,
      tax_paise: tax,
      utr: nextUtr(),
      status: "processed",
      created_at: settledAt,
    });
  }

  // ON_HOLD - prefer batches that carry no other defect so the signals stay clean.
  const defectiveEntityIds = new Set(labels.map((l) => l.record_id));
  const linesBySettlement = new Map<string, SettlementLine[]>();
  for (const line of lines) {
    const list = linesBySettlement.get(line.settlement_id);
    if (list) list.push(line);
    else linesBySettlement.set(line.settlement_id, [line]);
  }
  const isClean = (s: Settlement): boolean =>
    (linesBySettlement.get(s.settlement_id) ?? []).every(
      (l) =>
        !defectiveEntityIds.has(l.entity_id) &&
        !(l.payment_id !== null && defectiveEntityIds.has(l.payment_id)) &&
        !(l.order_id !== null && defectiveEntityIds.has(l.order_id)),
    );
  const onHoldCount = need("ON_HOLD");
  if (onHoldCount > settlements.length) {
    throw new Error(
      `not enough settlements for ON_HOLD: need ${onHoldCount}, have ${settlements.length}.`,
    );
  }
  const holdPool = [
    ...shuffled(rng, settlements.filter(isClean)),
    ...shuffled(rng, settlements.filter((s) => !isClean(s))),
  ];
  for (const settlement of holdPool.slice(0, onHoldCount)) {
    settlement.status = "on_hold";
    claimed.add(settlement.settlement_id);
    labels.push({
      record_type: "settlement",
      record_id: settlement.settlement_id,
      true_cause: "ON_HOLD",
      note: `Settlement of ${settlement.net_amount_paise} paise (UTR ${settlement.utr}) is on hold; no bank credit was ever issued.`,
    });
  }

  // ------------------------------------------------------------ bank statement
  const bank: BankTxn[] = [];
  for (const settlement of settlements) {
    if (settlement.status !== "processed") continue;
    const template = pick(rng, BANK_DESCRIPTIONS);
    bank.push({
      bank_txn_id: bankTxnId(rng),
      value_date: toIsoDate(fromIso(settlement.created_at)),
      description: template(settlement.utr),
      credit_paise: settlement.net_amount_paise,
      debit_paise: 0,
      running_balance_paise: 0,
    });
  }

  // UNEXPLAINED - a credit whose UTR is in no settlement.
  const bankDays = bank.map((b) => b.value_date).sort();
  const firstDay = bankDays[0] ?? toIsoDate(WINDOW_START_MS);
  const lastDay = bankDays[bankDays.length - 1] ?? toIsoDate(WINDOW_END_MS);
  const firstDayMs = Date.parse(`${firstDay}T00:00:00Z`);
  const lastDayMs = Date.parse(`${lastDay}T00:00:00Z`);
  for (let i = 0; i < need("UNEXPLAINED"); i++) {
    const ghostUtr = nextUtr();
    const template = pick(rng, BANK_DESCRIPTIONS);
    const amount = randInt(rng, 1_000, 80_000) * 100;
    const dayMs = firstDayMs + randInt(rng, 0, Math.max(0, Math.round((lastDayMs - firstDayMs) / DAY_MS))) * DAY_MS;
    const txn: BankTxn = {
      bank_txn_id: bankTxnId(rng),
      value_date: toIsoDate(dayMs),
      description: template(ghostUtr),
      credit_paise: amount,
      debit_paise: 0,
      running_balance_paise: 0,
    };
    bank.push(txn);
    labels.push({
      record_type: "bank_txn",
      record_id: txn.bank_txn_id,
      true_cause: "UNEXPLAINED",
      note: `Bank credit of ${amount} paise carrying UTR ${ghostUtr}, which belongs to no settlement in the report.`,
    });
  }

  bank.sort((a, b) =>
    a.value_date === b.value_date
      ? a.bank_txn_id.localeCompare(b.bank_txn_id)
      : a.value_date.localeCompare(b.value_date),
  );
  let balance = OPENING_BALANCE_PAISE;
  for (const txn of bank) {
    balance += txn.credit_paise - txn.debit_paise;
    txn.running_balance_paise = balance;
  }

  // ------------------------------------------------------------------ output
  orders.sort((a, b) =>
    a.created_at === b.created_at
      ? a.order_id.localeCompare(b.order_id)
      : a.created_at.localeCompare(b.created_at),
  );
  lines.sort((a, b) => {
    if (a.settled_at !== b.settled_at) return a.settled_at.localeCompare(b.settled_at);
    if (a.settlement_id !== b.settlement_id) return a.settlement_id.localeCompare(b.settlement_id);
    return a.entity_id.localeCompare(b.entity_id);
  });
  settlements.sort((a, b) =>
    a.created_at === b.created_at
      ? a.settlement_id.localeCompare(b.settlement_id)
      : a.created_at.localeCompare(b.created_at),
  );
  labels.sort((a, b) =>
    a.record_id === b.record_id
      ? a.true_cause.localeCompare(b.true_cause)
      : a.record_id.localeCompare(b.record_id),
  );

  const total = [...plan.values()].reduce((sum, n) => sum + n, 0);
  if (labels.length !== total) {
    throw new Error(`injected ${labels.length} defects but planned ${total}`);
  }

  return {
    dataset: { orders, payments, refunds, lines, settlements, bank, labels },
    plan,
    options,
  };
}
