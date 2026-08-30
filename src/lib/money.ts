/** Integer-paise money helpers. No floats ever reach a stored amount. */

/** Fee rate slabs, expressed in basis points so the math stays integral. */
export const METHOD_FEE_BP: Readonly<Record<string, number>> = {
  upi: 0, // 0.0%
  card: 200, // 2.0%
  netbanking: 180, // 1.8%
  wallet: 220, // 2.2%
};

/** 0.4 percentage points, the FEE_VARIANCE offset. */
export const FEE_VARIANCE_BP = 40;

export const GST_PERCENT = 18;

export function feePaise(amountPaise: number, bp: number): number {
  return Math.round((amountPaise * bp) / 10_000);
}

export function taxPaise(fee: number): number {
  return Math.round((fee * GST_PERCENT) / 100);
}

/** 12453000 -> "1,24,530.00" (Indian digit grouping, two decimals). */
export function formatIndianRupees(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const fraction = (abs % 100).toString().padStart(2, "0");
  const digits = rupees.toString();

  let grouped: string;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    const last3 = digits.slice(-3);
    let rest = digits.slice(0, -3);
    const parts: string[] = [];
    while (rest.length > 2) {
      parts.unshift(rest.slice(-2));
      rest = rest.slice(0, -2);
    }
    if (rest.length > 0) parts.unshift(rest);
    grouped = `${parts.join(",")},${last3}`;
  }
  return `${negative ? "-" : ""}${grouped}.${fraction}`;
}

/** "1,24,530.00" -> 12453000. Empty string -> 0. */
export function parseIndianRupees(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  const negative = trimmed.startsWith("-");
  const body = (negative ? trimmed.slice(1) : trimmed).replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(body)) {
    throw new Error(`unparseable amount: ${JSON.stringify(text)}`);
  }
  const [whole, fraction = "0"] = body.split(".");
  const paise = Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
  return negative ? -paise : paise;
}
