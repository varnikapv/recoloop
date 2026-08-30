/**
 * RecoLoop domain model.
 *
 * MONEY RULE: every monetary value in this file is an integer number of paise.
 * There are no floats anywhere in the money path.
 */

export type Currency = "INR";

export type OrderStatus = "paid" | "pending" | "cancelled";

export type PaymentMethod = "upi" | "card" | "netbanking" | "wallet";

export type PaymentStatus = "captured" | "authorized" | "refunded" | "failed";

export type SettlementLineType = "payment" | "refund" | "adjustment";

export type SettlementStatus = "processed" | "on_hold";

/** The merchant's internal order ledger row. */
export interface Order {
  order_id: string;
  amount_paise: number;
  currency: Currency;
  /** ISO-8601 UTC, second precision. */
  created_at: string;
  status: OrderStatus;
}

export interface Payment {
  payment_id: string;
  order_id: string;
  amount_paise: number;
  fee_paise: number;
  tax_paise: number;
  method: PaymentMethod;
  status: PaymentStatus;
  /** ISO-8601 UTC, second precision. */
  captured_at: string;
}

export interface Refund {
  refund_id: string;
  payment_id: string;
  amount_paise: number;
  /** ISO-8601 UTC, second precision. */
  created_at: string;
}

/**
 * One row of the gateway settlement report.
 *
 * `order_id` / `payment_id` / `method` are the join columns the real Razorpay
 * recon report carries; they are null on lines where the gateway has nothing to
 * join to (adjustments), or point at an entity outside this dataset when the
 * underlying payment belongs to a prior cycle.
 */
export interface SettlementLine {
  entity_id: string;
  type: SettlementLineType;
  debit_paise: number;
  credit_paise: number;
  amount_paise: number;
  fee_paise: number;
  tax_paise: number;
  settlement_id: string;
  /** ISO-8601 UTC, second precision. */
  settled_at: string;
  order_id: string | null;
  payment_id: string | null;
  method: PaymentMethod | null;
}

export interface Settlement {
  settlement_id: string;
  /** sum(line.credit_paise) - sum(line.debit_paise) over this settlement's lines. */
  net_amount_paise: number;
  fee_paise: number;
  tax_paise: number;
  /** 12-digit numeric string. */
  utr: string;
  status: SettlementStatus;
  /** ISO-8601 UTC, second precision. */
  created_at: string;
}

export interface BankTxn {
  bank_txn_id: string;
  /** Canonical YYYY-MM-DD; rendered to the statement in mixed formats. */
  value_date: string;
  /** Free text containing the UTR. */
  description: string;
  credit_paise: number;
  debit_paise: number;
  running_balance_paise: number;
}

export const DEFECT_CAUSES = [
  "LATE_SETTLEMENT",
  "REFUND_NETTED",
  "PARTIAL_CAPTURE",
  "FEE_VARIANCE",
  "ON_HOLD",
  "DUPLICATE_WEBHOOK",
  "SILENT_UPI_FAIL",
  "CHARGEBACK_DEBIT",
  "UNEXPLAINED",
] as const;

export type DefectCause = (typeof DEFECT_CAUSES)[number];

export type LabelRecordType =
  | "order"
  | "payment"
  | "refund"
  | "settlement"
  | "settlement_line"
  | "bank_txn";

/** Ground truth. Lives ONLY in labels.json. */
export interface DefectLabel {
  record_type: LabelRecordType;
  record_id: string;
  true_cause: DefectCause;
  note: string;
}

export interface Dataset {
  orders: Order[];
  payments: Payment[];
  refunds: Refund[];
  lines: SettlementLine[];
  settlements: Settlement[];
  bank: BankTxn[];
  labels: DefectLabel[];
}
