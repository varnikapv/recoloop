/**
 * Residue assembly.
 *
 * Findings are grouped into residue entries by connected component over the
 * entities they own: if two findings touch the same record they describe one
 * unreconciled situation, not two. That also guarantees every owned entity
 * lands in exactly one residue entry, which is what the partition assertion in
 * run.ts checks.
 */
import type { NormalizedBankTxn, NormalizedLine, NormalizedOrder } from "../normalize";
import type {
  Candidate,
  EntityKind,
  Evidence,
  Finding,
  FindingCode,
  ResidueEntity,
  ResidueEntry,
  ResidueFinding,
} from "./types";
import { entityKey } from "./types";

/** FNV-1a, so residue ids are stable without pulling in a hash dependency. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  find(id: string): string {
    let root = id;
    while ((this.parent.get(root) ?? root) !== root) root = this.parent.get(root) ?? root;
    let cursor = id;
    while (cursor !== root) {
      const next = this.parent.get(cursor) ?? cursor;
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export interface ResidueInput {
  findings: readonly Finding[];
  orders: readonly NormalizedOrder[];
  lines: readonly NormalizedLine[];
  bank: readonly NormalizedBankTxn[];
}

const ENTITY_BUCKET: Readonly<Record<EntityKind, keyof ResidueEntry["entities"]>> = {
  order: "orders",
  settlement_line: "settlement_lines",
  settlement: "settlements",
  bank_txn: "bank_txns",
};

export function buildResidue(input: ResidueInput): ResidueEntry[] {
  const { findings, orders, lines, bank } = input;

  const uf = new UnionFind();
  for (const finding of findings) {
    const keys = finding.entities.map((e) => entityKey(e.kind, e.id));
    const first = keys[0];
    if (first === undefined) continue;
    for (const key of keys) uf.union(first, key);
  }

  const componentFindings = new Map<string, Finding[]>();
  for (const finding of findings) {
    const first = finding.entities[0];
    if (first === undefined) continue;
    const root = uf.find(entityKey(first.kind, first.id));
    const bucket = componentFindings.get(root);
    if (bucket) bucket.push(finding);
    else componentFindings.set(root, [finding]);
  }

  const orderById = new Map(orders.map((o) => [o.order_id, o]));
  const lineById = new Map(lines.map((l) => [l.entity_id, l]));
  const bankById = new Map(bank.map((b) => [b.bank_txn_id, b]));
  const settlementLines = new Map<string, NormalizedLine[]>();
  for (const line of lines) {
    const bucket = settlementLines.get(line.settlement_id);
    if (bucket) bucket.push(line);
    else settlementLines.set(line.settlement_id, [line]);
  }

  const materialize = (kind: EntityKind, id: string): ResidueEntity => {
    if (kind === "order") {
      const order = orderById.get(id);
      if (!order) throw new Error(`residue references unknown order ${id}`);
      const { raw, ...normalized } = order;
      return { kind, id, normalized, raw };
    }
    if (kind === "settlement_line") {
      const line = lineById.get(id);
      if (!line) throw new Error(`residue references unknown settlement line ${id}`);
      const { raw, ...normalized } = line;
      return { kind, id, normalized, raw };
    }
    if (kind === "bank_txn") {
      const row = bankById.get(id);
      if (!row) throw new Error(`residue references unknown bank txn ${id}`);
      const { raw, ...normalized } = row;
      return { kind, id, normalized, raw };
    }
    const group = settlementLines.get(id);
    const head = group?.[0];
    if (!head) throw new Error(`residue references unknown settlement ${id}`);
    let net = 0;
    for (const line of group) net += line.credit_paise - line.debit_paise;
    return {
      kind,
      id,
      normalized: {
        settlement_id: id,
        utr: head.settlement_utr,
        status: head.settlement_status,
        settled_at: head.settled_at,
        expected_net_paise: net,
        stated_net_paise: head.settlement_net_amount_paise,
        line_count: group.length,
      },
      raw: {
        settlement_id: head.raw["settlement_id"] ?? "",
        settlement_utr: head.raw["settlement_utr"] ?? "",
        settlement_status: head.raw["settlement_status"] ?? "",
        settlement_net_amount_paise: head.raw["settlement_net_amount_paise"] ?? "",
        settlement_created_at: head.raw["settlement_created_at"] ?? "",
      },
    };
  };

  const entries: ResidueEntry[] = [];
  for (const [, group] of componentFindings) {
    const owned = new Map<string, { kind: EntityKind; id: string }>();
    for (const finding of group) {
      for (const entity of finding.entities) {
        owned.set(entityKey(entity.kind, entity.id), entity);
      }
    }
    const sortedOwned = [...owned.keys()].sort();

    const entities: ResidueEntry["entities"] = {};
    for (const key of sortedOwned) {
      const entity = owned.get(key);
      if (!entity) continue;
      const bucketName = ENTITY_BUCKET[entity.kind];
      const bucket = entities[bucketName] ?? [];
      bucket.push(materialize(entity.kind, entity.id));
      entities[bucketName] = bucket;
    }

    const evidence: Evidence = {};
    for (const finding of group) {
      for (const [key, value] of Object.entries(finding.evidence)) {
        const target = key in evidence ? `${finding.code}.${key}` : key;
        evidence[target] = value;
      }
    }

    const candidates: Candidate[] = [];
    const seenCandidates = new Set<string>();
    for (const finding of group) {
      for (const candidate of finding.candidates) {
        const key = `${candidate.kind}:${candidate.id}:${candidate.reason}`;
        if (seenCandidates.has(key)) continue;
        seenCandidates.add(key);
        candidates.push(candidate);
      }
    }

    const codes = [...new Set(group.map((f) => f.code))].sort() as FindingCode[];
    const perFinding: ResidueFinding[] = group
      .map((finding) => ({
        code: finding.code,
        entity_ids: finding.entities.map((e) => e.id).sort(),
      }))
      .sort(
        (a, b) =>
          a.code.localeCompare(b.code) || a.entity_ids.join(",").localeCompare(b.entity_ids.join(",")),
      );
    entries.push({
      residue_id: `res_${fnv1a(sortedOwned.join("|"))}`,
      finding_types: codes,
      findings: perFinding,
      entities,
      candidates,
      evidence,
    });
  }

  entries.sort((a, b) => a.residue_id.localeCompare(b.residue_id));

  const ids = new Set(entries.map((e) => e.residue_id));
  if (ids.size !== entries.length) {
    throw new Error("residue_id collision: two components hashed to the same id");
  }
  return entries;
}

/** Value at stake in a residue entry: gross of what its lines moved. */
export function residueValuePaise(entry: ResidueEntry): number {
  let total = 0;
  for (const line of entry.entities.settlement_lines ?? []) {
    const normalized = line.normalized as { amount_paise?: number };
    total += normalized.amount_paise ?? 0;
  }
  if ((entry.entities.settlement_lines ?? []).length === 0) {
    for (const row of entry.entities.bank_txns ?? []) {
      const normalized = row.normalized as { credit_paise?: number };
      total += normalized.credit_paise ?? 0;
    }
    for (const order of entry.entities.orders ?? []) {
      const normalized = order.normalized as { amount_paise?: number };
      total += normalized.amount_paise ?? 0;
    }
  }
  return total;
}
