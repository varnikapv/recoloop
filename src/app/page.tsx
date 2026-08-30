/**
 * Server component: reads the artefacts at request time and hands the client
 * shell a fully populated payload, so the queue paints with real numbers on the
 * first frame rather than flashing an empty state.
 *
 * Decisions go back through /api/review, which reads the same module.
 */
import { loadReview } from "../lib/ui/review";
import ReviewClient from "./ReviewClient";

export const dynamic = "force-dynamic";

const SEED = 42;

export default function Page() {
  try {
    return <ReviewClient initial={loadReview(SEED)} />;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return (
      <main className="empty">
        <h1 className="wordmark">RecoLoop</h1>
        <p>
          Could not load <code className="mono">data/{SEED}</code>: {message}
        </p>
        <p>
          Run <code className="mono">npx tsx scripts/generate.ts --seed {SEED}</code>, then{" "}
          <code className="mono">scripts/match.ts</code> and{" "}
          <code className="mono">scripts/classify.ts</code>.
        </p>
      </main>
    );
  }
}
