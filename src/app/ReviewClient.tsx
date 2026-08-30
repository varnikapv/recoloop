"use client";

import { useCallback, useMemo, useState } from "react";

import { formatIndianRupees } from "../lib/money";
import type {
  AuditEntry,
  ReviewAction,
  ReviewCandidate,
  ReviewCase,
  ReviewEntity,
  ReviewPayload,
} from "../lib/ui/review";

// ------------------------------------------------------------- formatting

const rupees = (paise: number): string => `₹${formatIndianRupees(paise)}`;

const ACRONYMS: Readonly<Record<string, string>> = {
  utr: "UTR",
  id: "ID",
  ids: "IDs",
  bp: "bp",
  pct: "%",
  upi: "UPI",
};

/** "expected_net_paise" -> "Expected net"; "bank_rows_for_utr" -> "Bank rows for UTR". */
function humanize(key: string): string {
  const words = key.replace(/_paise$/, "").split("_");
  const text = words
    .map((word) => ACRONYMS[word] ?? word)
    .join(" ")
    .trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * When several findings merge into one case, colliding evidence keys are
 * namespaced by the matcher as "FINDING_CODE.key". Split that back apart so the
 * label reads as a field with a scope, not as a mangled sentence.
 */
function splitScope(key: string): { label: string; scope: string | null } {
  const dot = key.indexOf(".");
  if (dot < 0) return { label: humanize(key), scope: null };
  return { label: humanize(key.slice(dot + 1)), scope: key.slice(0, dot) };
}

interface Rendered {
  text: string;
  unit: string | null;
}

function renderValue(key: string, value: unknown): Rendered {
  if (value === null || value === undefined || value === "") {
    return { text: "none", unit: null };
  }
  if (key.endsWith("_paise") && typeof value === "number") {
    return { text: rupees(value), unit: `${value} p` };
  }
  if (typeof value === "number") return { text: String(value), unit: null };
  return { text: String(value), unit: null };
}

const shortId = (id: string): string => (id.length > 22 ? `${id.slice(0, 20)}…` : id);

/** The fields worth showing per entity kind; anything else stays in the file. */
const KEY_FIELDS: Readonly<Record<string, string[]>> = {
  order: ["amount_paise", "status", "created_at", "currency"],
  settlement_line: [
    "type",
    "amount_paise",
    "credit_paise",
    "debit_paise",
    "fee_paise",
    "tax_paise",
    "method",
    "settled_at",
    "settlement_status",
  ],
  settlement: ["status", "expected_net_paise", "stated_net_paise", "utr", "settled_at", "line_count"],
  bank_txn: ["credit_paise", "value_date", "utr", "description"],
};

function entityFields(entity: ReviewEntity): Array<[string, unknown]> {
  const preferred = KEY_FIELDS[entity.kind];
  if (preferred !== undefined) {
    return preferred
      .filter((field) => entity.normalized[field] !== undefined)
      .map((field) => [field, entity.normalized[field]] as [string, unknown]);
  }
  // Unknown kind: show everything except internal epoch mirrors.
  return Object.entries(entity.normalized).filter(([key]) => !key.endsWith("_ms"));
}

// ------------------------------------------------------------- components

function ConfidenceBar({
  confidence,
  threshold,
  wide = false,
}: {
  confidence: number;
  threshold: number;
  wide?: boolean;
}) {
  return (
    <span className={`conf-track${wide ? " conf-track--wide" : ""}`}>
      <span
        className={`conf-fill${confidence < threshold ? " conf-fill--low" : ""}`}
        style={{ width: `${Math.round(confidence * 100)}%` }}
      />
    </span>
  );
}

function Ledger({ rows }: { rows: Array<[string, unknown]> }) {
  return (
    <dl className="ledger">
      {rows.map(([key, value]) => {
        const rendered = renderValue(key, value);
        const scoped = splitScope(key);
        const isText = typeof value === "string" && value.length > 24;
        return (
          <div key={key} className={`ledger-row${isText ? " ledger-row--text" : ""}`}>
            <dt>
              {scoped.label}
              {scoped.scope !== null && <span className="ledger-scope mono">from {scoped.scope}</span>}
            </dt>
            <dd className={isText ? undefined : "mono"}>
              {rendered.text}
              {rendered.unit !== null && <span className="unit mono">{rendered.unit}</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function EntityCard({ entity, ruledOut }: { entity: ReviewEntity; ruledOut?: ReviewCandidate }) {
  const fields =
    ruledOut === undefined
      ? entityFields(entity)
      : (Object.entries(ruledOut.evidence) as Array<[string, unknown]>);
  return (
    <article className={`card${ruledOut === undefined ? "" : " card--ruled-out"}`}>
      <header className="card-head">
        <span className="card-kind">{entity.kind.replace(/_/g, " ")}</span>
        <span className="card-id mono" title={entity.id}>
          {shortId(entity.id)}
        </span>
      </header>
      {ruledOut !== undefined && <p className="ruled-out-why">{ruledOut.reason}</p>}
      <dl className="kv">
        {fields.map(([key, value]) => {
          const rendered = renderValue(key, value);
          return (
            <div key={key} style={{ display: "contents" }}>
              <dt>{humanize(key)}</dt>
              <dd className="mono">{rendered.text}</dd>
            </div>
          );
        })}
      </dl>
    </article>
  );
}

// ------------------------------------------------------------------ page

type Filter = "all" | "review" | "auto";

export default function ReviewClient({ initial }: { initial: ReviewPayload }) {
  const { cases, causes, confidence_threshold: threshold, summary, seed } = initial;

  const [audit, setAudit] = useState<AuditEntry[]>(initial.audit);
  const [selectedId, setSelectedId] = useState<string>(cases[0]?.residue_id ?? "");
  const [filter, setFilter] = useState<Filter>("all");
  const [mode, setMode] = useState<"idle" | "reject" | "reclassify">("idle");
  const [note, setNote] = useState("");
  const [nextCause, setNextCause] = useState<string>(causes[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Latest decision per case, so a pill flips the moment the reviewer acts. */
  const decisions = useMemo(() => {
    const map = new Map<string, AuditEntry>();
    for (const entry of audit) map.set(entry.residue_id, entry);
    return map;
  }, [audit]);

  const visible = useMemo(
    () => (filter === "all" ? cases : cases.filter((entry) => entry.bucket === filter)),
    [cases, filter],
  );
  const selected = cases.find((entry) => entry.residue_id === selectedId) ?? null;
  const decision = selected === null ? undefined : decisions.get(selected.residue_id);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    setMode("idle");
    setNote("");
    setError(null);
  }, []);

  const submit = useCallback(
    async (action: ReviewAction, finalCause?: string) => {
      if (selected === null) return;
      setBusy(true);
      setError(null);
      // Optimistic: the pill flips now; a failed write rolls it back.
      const optimistic: AuditEntry = {
        timestamp: new Date().toISOString(),
        residue_id: selected.residue_id,
        action,
        original_prediction: selected.predicted_cause ?? "UNCLASSIFIED",
        final_cause:
          action === "reclassify"
            ? (finalCause ?? "")
            : action === "reject"
              ? "REJECTED"
              : (selected.predicted_cause ?? "UNCLASSIFIED"),
        reviewer_note: note.trim() === "" ? null : note.trim(),
        original_confidence: selected.confidence ?? 0,
        gate_forced: selected.gate_forced_review,
      };
      setAudit((previous) => [...previous, optimistic]);
      try {
        const response = await fetch(`/api/review?seed=${seed}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            residue_id: selected.residue_id,
            action,
            final_cause: finalCause ?? null,
            reviewer_note: note.trim() === "" ? null : note.trim(),
          }),
        });
        const body = (await response.json()) as { entry?: AuditEntry; error?: string };
        if (!response.ok || body.entry === undefined) {
          throw new Error(body.error ?? `write failed (${response.status})`);
        }
        // Replace the optimistic row with the server's authoritative one.
        const written = body.entry;
        setAudit((previous) => previous.map((row) => (row === optimistic ? written : row)));
        setMode("idle");
        setNote("");
      } catch (caught) {
        setAudit((previous) => previous.filter((row) => row !== optimistic));
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    },
    [note, seed, selected],
  );

  const decidedCount = decisions.size;
  const stats: Array<{ label: string; value: string; sub?: string; attention?: boolean }> = [
    { label: "residue", value: String(summary.residue_count), sub: "cases" },
    {
      label: "in review",
      value: String(summary.review_count),
      sub: rupees(summary.review_value_paise),
      attention: true,
    },
    {
      label: "auto-approved",
      value: String(summary.auto_count),
      sub: rupees(summary.auto_value_paise),
    },
    { label: "decided", value: String(decidedCount), sub: "this log" },
  ];

  return (
    <div className="shell">
      <header className="masthead">
        <h1 className="wordmark">
          RecoLoop
          <span>Exception review · seed {seed}</span>
        </h1>
        <dl className="stats">
          {stats.map((stat) => (
            <div key={stat.label} className={`stat${stat.attention === true ? " stat--attention" : ""}`}>
              <dt>{stat.label}</dt>
              <dd className="mono">
                {stat.value}
                {stat.sub !== undefined && <small>{stat.sub}</small>}
              </dd>
            </div>
          ))}
        </dl>
      </header>

      <div className="body">
        <nav className="queue" aria-label="Case queue">
          <div className="filters">
            {(["all", "review", "auto"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className="filter"
                aria-pressed={filter === option}
                onClick={() => {
                  setFilter(option);
                }}
              >
                {option === "all" ? "All" : option === "review" ? "Review only" : "Auto-approved"}
              </button>
            ))}
          </div>

          <div className="queue-list">
            {visible.map((entry) => {
              const decided = decisions.get(entry.residue_id);
              const rowClass =
                decided !== undefined
                  ? "case-row case-row--decided"
                  : entry.bucket === "review"
                    ? "case-row case-row--review"
                    : "case-row";
              const cause = decided?.final_cause ?? entry.predicted_cause ?? "—";
              return (
                <button
                  key={entry.residue_id}
                  type="button"
                  className={rowClass}
                  aria-current={entry.residue_id === selectedId}
                  onClick={() => {
                    select(entry.residue_id);
                  }}
                >
                  <span className="case-row-top">
                    <span className="case-id mono">{entry.residue_id.replace("res_", "")}</span>
                    <span
                      className={
                        decided !== undefined
                          ? "pill pill--decided"
                          : entry.bucket === "review"
                            ? "pill pill--review"
                            : "pill pill--auto"
                      }
                    >
                      {decided !== undefined
                        ? "Decided"
                        : entry.bucket === "review"
                          ? "In review"
                          : "Auto-approved"}
                    </span>
                  </span>
                  <span className="case-cause">{cause}</span>
                  <span className="case-row-bottom">
                    <span
                      className={`case-amount mono${entry.proposed_amount_paise === null ? " case-amount--none" : ""}`}
                    >
                      {entry.proposed_amount_paise === null
                        ? "no entry"
                        : rupees(entry.proposed_amount_paise)}
                    </span>
                    {entry.confidence !== null && (
                      <span className="conf">
                        <ConfidenceBar confidence={entry.confidence} threshold={threshold} />
                        <span className="mono">{entry.confidence.toFixed(2)}</span>
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          <details className="audit">
            <summary>Audit log ({audit.length} {audit.length === 1 ? "entry" : "entries"})</summary>
            <div className="audit-list">
              {audit.length === 0 ? (
                <p className="audit-empty">
                  No decisions recorded yet. Every action appends one line to{" "}
                  <span className="mono">audit_log.jsonl</span> and nothing is ever rewritten.
                </p>
              ) : (
                [...audit].reverse().map((row, index) => (
                  <div className="audit-row" key={`${row.timestamp}-${row.residue_id}-${index}`}>
                    <div className="audit-when mono">{row.timestamp.replace("T", " ").replace(/\.\d+Z$/, "Z")}</div>
                    <div className="audit-move">
                      <strong>{row.action}</strong>{" "}
                      <span className="mono">{row.residue_id.replace("res_", "")}</span>
                      {row.original_prediction !== row.final_cause && (
                        <>
                          {" · "}
                          {row.original_prediction} {"→"} {row.final_cause}
                        </>
                      )}
                    </div>
                    {row.reviewer_note !== null && <div className="audit-note">{row.reviewer_note}</div>}
                  </div>
                ))
              )}
            </div>
          </details>
        </nav>

        <main className="detail">
          {selected === null ? (
            <div className="empty">Select a case from the queue.</div>
          ) : (
            <>
              <div className="detail-scroll">
                <div className="detail-head">
                  <h2 className="mono">{selected.residue_id}</h2>
                  <span className="card-kind">
                    {selected.entities.length} entit{selected.entities.length === 1 ? "y" : "ies"}
                    {selected.candidates.length > 0 && ` · ${selected.candidates.length} ruled out`}
                  </span>
                </div>
                <div className="findings">
                  {selected.finding_types.map((code) => (
                    <span className="finding-tag mono" key={code}>
                      {code}
                    </span>
                  ))}
                </div>

                <section className="block">
                  <h3 className="block-title">Evidence · computed by the matcher</h3>
                  <Ledger rows={Object.entries(selected.evidence)} />
                </section>

                <section className="block">
                  <h3 className="block-title">Entities involved</h3>
                  <div className="cards">
                    {selected.entities.map((entity) => (
                      <EntityCard key={`${entity.kind}:${entity.id}`} entity={entity} />
                    ))}
                  </div>
                </section>

                {selected.candidates.length > 0 && (
                  <section className="block">
                    <h3 className="block-title">Considered and ruled out · not the match</h3>
                    <div className="cards">
                      {selected.candidates.map((candidate) => (
                        <EntityCard
                          key={`${candidate.kind}:${candidate.id}:${candidate.reason}`}
                          entity={{ kind: candidate.kind, id: candidate.id, normalized: {} }}
                          ruledOut={candidate}
                        />
                      ))}
                    </div>
                  </section>
                )}

                <section className="block">
                  <h3 className="block-title">Model classification</h3>
                  {selected.predicted_cause === null ? (
                    <p className="empty">This case was never classified. It needs a human decision.</p>
                  ) : (
                    <>
                      <div className="verdict">
                        <div className="verdict-top">
                          <div>
                            <div className="verdict-cause">{selected.predicted_cause}</div>
                            <div className="verdict-meta mono">
                              {selected.provider} {"·"} {selected.model}
                            </div>
                          </div>
                          <div className="verdict-conf">
                            <div className="verdict-conf-value mono">
                              {(selected.confidence ?? 0).toFixed(2)}
                            </div>
                            <div className="card-kind">confidence</div>
                            <ConfidenceBar
                              confidence={selected.confidence ?? 0}
                              threshold={threshold}
                              wide
                            />
                          </div>
                        </div>
                        <div className="verdict-body">
                          <p className="reasoning">{selected.reasoning}</p>
                          <div className="proposal">
                            <div>
                              <div className="proposal-label">Proposed adjusting entry</div>
                              <div>{selected.proposed_action ?? "No entry proposed."}</div>
                            </div>
                            <div className="proposal-amount mono">
                              {selected.proposed_amount_paise === null
                                ? "—"
                                : rupees(selected.proposed_amount_paise)}
                            </div>
                          </div>
                        </div>
                      </div>
                      <ReviewReason entry={selected} threshold={threshold} />
                    </>
                  )}
                </section>
              </div>

              {error !== null && <div className="error-banner">{error}</div>}

              {decision === undefined ? (
                <div className="decision">
                  <span className="decision-label">
                    {mode === "idle"
                      ? "Decision"
                      : mode === "reject"
                        ? "Why is this wrong?"
                        : "Correct cause"}
                  </span>
                  {mode === "reject" && (
                    <input
                      className="decision-input"
                      placeholder="Reason for rejection (recorded in the audit log)"
                      value={note}
                      onChange={(event) => {
                        setNote(event.target.value);
                      }}
                      autoFocus
                    />
                  )}
                  {mode === "reclassify" && (
                    <>
                      <select
                        className="decision-input"
                        value={nextCause}
                        onChange={(event) => {
                          setNextCause(event.target.value);
                        }}
                      >
                        {causes.map((cause) => (
                          <option key={cause} value={cause}>
                            {cause}
                          </option>
                        ))}
                      </select>
                      <input
                        className="decision-input"
                        placeholder="Note (optional)"
                        value={note}
                        onChange={(event) => {
                          setNote(event.target.value);
                        }}
                      />
                    </>
                  )}

                  {mode === "idle" ? (
                    <>
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={busy}
                        onClick={() => void submit("approve")}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="btn btn--danger"
                        disabled={busy}
                        onClick={() => {
                          setMode("reject");
                        }}
                      >
                        Reject
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          setMode("reclassify");
                        }}
                      >
                        Reclassify
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          setMode("idle");
                          setNote("");
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={busy || (mode === "reject" && note.trim() === "")}
                        onClick={() =>
                          void submit(mode === "reject" ? "reject" : "reclassify", nextCause)
                        }
                      >
                        {busy ? "Writing…" : "Record decision"}
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <div className="decided-note">
                  <strong>{decision.action}</strong>
                  <span>
                    recorded {decision.timestamp.replace("T", " ").replace(/\.\d+Z$/, "Z")}
                    {decision.original_prediction !== decision.final_cause &&
                      ` · ${decision.original_prediction} → ${decision.final_cause}`}
                    {decision.reviewer_note !== null && ` · “${decision.reviewer_note}”`}
                  </span>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

/**
 * Why this case is in front of a human. The distinction matters: a case the
 * model itself flagged while still confident is a different signal from one the
 * 0.7 gate caught, and conflating them hides whether the gate is doing anything.
 */
function ReviewReason({ entry, threshold }: { entry: ReviewCase; threshold: number }) {
  if (!entry.requires_human_review) {
    return (
      <div className="reason-banner reason-banner--neutral">
        <span className="reason-kicker">Auto-approved</span>
        <span className="reason-text">
          Confidence {(entry.confidence ?? 0).toFixed(2)} is at or above the {threshold.toFixed(2)}{" "}
          gate and the model did not ask for review. This entry would be booked without a human
          reading it.
        </span>
      </div>
    );
  }
  const belowGate = (entry.confidence ?? 0) < threshold;
  return (
    <div className="reason-banner">
      <span className="reason-kicker">
        {belowGate ? "Below confidence threshold" : "Model flagged for review"}
      </span>
      <span className="reason-text">
        {belowGate
          ? `Confidence ${(entry.confidence ?? 0).toFixed(2)} is under the ${threshold.toFixed(2)} gate, so review was forced regardless of the predicted cause.`
          : `Confidence ${(entry.confidence ?? 0).toFixed(2)} is at or above the ${threshold.toFixed(2)} gate. The model asked for review on its own judgment — the gate did not fire.`}
      </span>
    </div>
  );
}
