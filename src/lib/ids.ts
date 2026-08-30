import { type Rng, randInt } from "./rng";

const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
const DIGITS = "0123456789";

function randomString(rng: Rng, length: number, alphabet: string): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(rng() * alphabet.length)] as string;
  }
  return out;
}

/**
 * Gateway-style ids: prefix + 14 alphanumeric characters. Lowercase-only so the
 * "mixed case" dirt is losslessly reversible by trim+lowercase.
 */
export function gatewayId(rng: Rng, prefix: string): string {
  return `${prefix}${randomString(rng, 14, ALNUM)}`;
}

export function utr(rng: Rng): string {
  return randomString(rng, 12, DIGITS);
}

export function bankTxnId(rng: Rng): string {
  return `txn${randomString(rng, 12, DIGITS)}`;
}

/**
 * ~8% of ID cells in the CSVs carry leading/trailing whitespace and/or mixed
 * case. This is NOISE, applied uniformly at random across every ID column of
 * every file - it is never correlated with a defect.
 */
export function dirtyId(rng: Rng, id: string, probability = 0.08): string {
  if (rng() >= probability) return id;
  let out = id;
  const mode = randInt(rng, 0, 2);
  if (mode === 0) out = out.toUpperCase();
  else if (mode === 1) out = out.slice(0, 4).toUpperCase() + out.slice(4);
  const lead = randInt(rng, 0, 2);
  const trail = randInt(rng, 0, 2);
  return `${" ".repeat(lead)}${out}${" ".repeat(trail)}`;
}
