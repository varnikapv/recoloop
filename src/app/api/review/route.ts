/**
 * The review UI's data plane. GET returns everything the page renders; POST
 * appends one immutable audit entry.
 *
 * Files are read at request time, never cached, so the page reflects whatever
 * the matcher and classifier last wrote.
 */
import {
  type AuditEntry,
  type ReviewAction,
  appendAuditEntry,
  loadReview,
} from "../../../lib/ui/review";

export const dynamic = "force-dynamic";

const DEFAULT_SEED = 42;

function seedFrom(request: Request): number {
  const raw = new URL(request.url).searchParams.get("seed");
  const seed = raw === null ? DEFAULT_SEED : Number(raw);
  if (!Number.isInteger(seed)) throw new Error(`bad seed: ${JSON.stringify(raw)}`);
  return seed;
}

function fail(error: unknown, status: number): Response {
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ error: message }, { status });
}

export function GET(request: Request): Response {
  try {
    return Response.json(loadReview(seedFrom(request)));
  } catch (error) {
    return fail(error, 500);
  }
}

const ACTIONS = new Set<ReviewAction>(["approve", "reject", "reclassify"]);

interface DecisionBody {
  residue_id?: unknown;
  action?: unknown;
  final_cause?: unknown;
  reviewer_note?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const seed = seedFrom(request);
    const body = (await request.json()) as DecisionBody;

    const residueId = typeof body.residue_id === "string" ? body.residue_id : "";
    if (residueId === "") return fail(new Error("residue_id is required"), 400);

    const action = body.action as ReviewAction;
    if (!ACTIONS.has(action)) {
      return fail(new Error(`action must be one of ${[...ACTIONS].join(", ")}`), 400);
    }

    // The case is re-read rather than trusted from the client, so the audit log
    // records what the model actually said, not what a browser claimed it said.
    const payload = loadReview(seed);
    const target = payload.cases.find((entry) => entry.residue_id === residueId);
    if (target === undefined) return fail(new Error(`unknown residue_id ${residueId}`), 404);

    const original = target.predicted_cause ?? "UNCLASSIFIED";
    let finalCause = original;
    if (action === "reclassify") {
      const chosen = typeof body.final_cause === "string" ? body.final_cause : "";
      if (!payload.causes.includes(chosen)) {
        return fail(new Error(`final_cause must be one of the ${payload.causes.length} causes`), 400);
      }
      finalCause = chosen;
    } else if (action === "reject") {
      finalCause = "REJECTED";
    }

    const note = typeof body.reviewer_note === "string" ? body.reviewer_note.trim() : "";
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      residue_id: residueId,
      action,
      original_prediction: original,
      final_cause: finalCause,
      reviewer_note: note === "" ? null : note,
      original_confidence: target.confidence ?? 0,
      gate_forced: target.gate_forced_review,
    };
    appendAuditEntry(seed, entry);
    return Response.json({ entry }, { status: 201 });
  } catch (error) {
    return fail(error, 500);
  }
}
