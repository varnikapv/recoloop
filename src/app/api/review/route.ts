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

/**
 * An error that already knows what it should surface as. Without this every
 * failure collapsed to a 500, so a mistyped seed and a genuinely broken server
 * were indistinguishable from the outside.
 */
class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function seedFrom(request: Request): number {
  const raw = new URL(request.url).searchParams.get("seed");
  if (raw === null) return DEFAULT_SEED;
  const seed = Number(raw);
  if (!Number.isInteger(seed)) {
    throw new HttpError(`seed must be an integer, got ${JSON.stringify(raw)}`, 400);
  }
  return seed;
}

/** A seed with no generated dataset is a missing resource, not a server fault. */
function reviewFor(seed: number): ReturnType<typeof loadReview> {
  try {
    return loadReview(seed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HttpError(
        `no dataset for seed ${seed}. Generate one with: ` +
          `npx tsx scripts/generate.ts --seed ${seed} && npx tsx scripts/match.ts --seed ${seed}`,
        404,
      );
    }
    throw error;
  }
}

function fail(error: unknown, status = 500): Response {
  const code = error instanceof HttpError ? error.status : status;
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ error: message }, { status: code });
}

export function GET(request: Request): Response {
  try {
    return Response.json(reviewFor(seedFrom(request)));
  } catch (error) {
    return fail(error);
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
    const payload = reviewFor(seed);
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
