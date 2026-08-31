# Failure log

Every defect found in RecoLoop during its own construction, what caught it, and
what it cost. Kept because the interesting question about a reconciliation
system is not whether it works on the happy path — it is what happens when it
does not, and whether anything would have told you.

Nine of these were found by a guardrail rather than by a person looking. Four
were found only because a sweep ran the same code over 42 seeds instead of one.
Two would have shipped silently and corrupted the headline number. Number 18 is
not an engineering bug at all — it is the output contract throwing away a correct
answer, and it is the only entry here left deliberately unfixed. Number 19 was
found last, by cloning the finished repo and running its own README.

**Legend.** *Silent* = would have produced a plausible wrong answer with no
error. *Loud* = crashed or refused to run.

| # | Layer | Defect | Failure mode | Caught by |
|---|---|---|---|---|
| 1 | Generator | Settlement rebalancer ping-ponged forever | Loud (hang) | 42-seed sweep |
| 2 | Generator | Refund larger than any batch could absorb | Loud | 42-seed sweep |
| 3 | Verifier | Net invariant checked on 5 of 30 settlements | Silent | User review |
| 4 | Verifier | Imported the constant it was meant to check | Silent | User review |
| 5 | Matcher | Clean refund lines went unaccounted | Loud | Partition assertion |
| 6 | Matcher | Reconciled settlements with no clean line vanished | Loud | Partition assertion |
| 7 | Matcher | `ORDER_WITHOUT_SETTLEMENT` could never fire | Silent | Finding-count review |
| 8 | Scoring | Cross-tab attribution muddied at volume | Silent | 5000-order run |
| 9 | Test harness | Python banker's rounding faked 9 false positives | Silent | Cross-check |
| 10 | Classifier | Torn JSONL line survived every rerun | Loud (later) | Crash-recovery test |
| 11 | Classifier | Resume treated transport failures as done | Silent | Live quota block |
| 12 | Classifier | Env var read before `.env` loaded | Silent | Live API call |
| 13 | Scoring | Partial-run ceiling message was incoherent | Silent | Partial run |
| 14 | Build guard | Guard failed on its own documentation | Loud | First run |
| 15 | UI | Decision bar overlapped the content it acts on | Silent | Screenshot |
| 16 | UI | Long identifiers overflowed their column | Silent | Screenshot |
| 17 | UI | Merged evidence keys rendered as mangled prose | Silent | Screenshot |
| 18 | Classifier contract | Output schema discarded a second real defect | Silent | Scorer ceiling analysis |
| 19 | Classifier CLI | Resume skipped a run it had never done | Silent | Clean-clone rehearsal |

---

## 1 — Settlement rebalancer ping-ponged forever

**Symptom.** `npx tsx scripts/generate.ts --seed 99` hung, then threw
`settlement rebalancing failed to converge` after 10,000 moves. Seeds 1, 7, 42
and 2024 were all fine.

**Root cause.** A settlement may not be a net debit, so oversized debits were
pushed to an adjacent day. The mover could go forward *or* backward, so a debit
too large for either neighbour bounced between them indefinitely.

**Fix.** [`src/lib/generate.ts`](src/lib/generate.ts) — replaced with a
forward-only carry sweep: each day absorbs what it can and carries the rest to
the next, with a final pass placing anything left into the roomiest batch.
Forward-only cannot cycle, so termination is structural rather than
guard-counted.

**Why it mattered.** The guard I had written turned an infinite loop into an
error message, which is why this was loud rather than a hang. But it also meant
roughly one seed in five could not generate a dataset at all.

## 2 — Refund larger than any batch could absorb

**Symptom.** Surfaced immediately behind #1: even with a correct sweep, some
seeds had a debit no settlement could take.

**Root cause.** Order amounts run to ₹85,000, but 500 orders over 30 days is
about ₹30,000 of gross credit per day. A full refund of a top-decile payment
exceeds an entire day's takings, so no batch could net positive around it.

**Fix.** [`src/lib/generate.ts`](src/lib/generate.ts) — debits are capped at half
the median daily gross credit, which excludes only the largest tickets from the
refund pool. Documented in the README as a stated modelling assumption rather
than buried.

**Why it mattered.** This is a modelling defect, not a coding one. The
distribution and the batching rule were individually reasonable and jointly
impossible. Only running many seeds exposed it.

## 3 — Net invariant checked on 5 of 30 settlements

**Symptom.** `verify.ts` reported "5 non-defective settlement(s) balance
exactly". A reviewer reading the code would reasonably ask what the other 25
were doing.

**Root cause.** The check was scoped to settlements carrying no labelled defect.
But no defect in the taxonomy perturbs that invariant — it holds 30/30 by
construction — so the scoping was checking a subset of something universally
true, and the low number looked like weak coverage.

**Fix.** [`scripts/verify.ts`](scripts/verify.ts) — asserted over the whole
population, and a second check added: net reconstructed from the *published fee
slabs*, which is the invariant `FEE_VARIANCE` actually breaks. Every settlement
is now covered either for exact correctness or for the exact expected deviation.

**Why it mattered.** Not a wrong answer — a weak claim dressed as a strong one.
The fix turned "I checked the easy cases" into "I checked every case".

## 4 — The verifier imported the constant it was meant to check

**Symptom.** None. Found by inspection while fixing #3.

**Root cause.** `verify.ts` imported `OPENING_BALANCE_PAISE` from the generator.
A wrong opening balance would have been wrong identically on both sides and the
check would have passed.

**Fix.** [`scripts/verify.ts`](scripts/verify.ts) — the verifier now imports no
business logic from the generator. Fee slabs, GST rate and the opening balance
are restated independently from the documented contract; only parsing helpers
are shared.

**Why it mattered.** A verifier that shares its subject's assumptions verifies
nothing about them. This is the class of bug that makes a green test suite
misleading.

## 5 — Clean refund lines went unaccounted

**Symptom.** `entity accounting failed (4 problem(s)): settlement_line
rfnd_… unaccounted for` on seeds 1, 2, 3, 4, 6, 7, 8… Seed 42 was clean, which
is why a single-seed run never showed it.

**Root cause.** A settlement line was skipped from the matched set when its
order was tainted. Correct for a payment line; wrong for a refund, whose
reconciliation does not depend on its parent order being clean. Those refund
lines were then in neither bucket.

**Fix.** [`src/lib/match/run.ts`](src/lib/match/run.ts) — ownership rule made
explicit: *an order is reconciled by its own payment, never by a refund raised
against it.* The taint check now applies only to payment lines.

## 6 — Reconciled settlements with no clean line vanished

**Symptom.** Same assertion, same sweep: `settlement setl_… unaccounted for`,
`bank_txn txn… unaccounted for`.

**Root cause.** A settlement's membership in the matched set was derived from
whether any of its lines survived. A batch that reconciled perfectly against its
bank credit but whose every line was individually disputed appeared nowhere.

**Fix.** [`src/lib/match/run.ts`](src/lib/match/run.ts) — settlement and bank
reconciliation now come from Stage 3's own verdict (`reconciled_settlements`,
`reconciled_bank_txns`), which is total by construction, rather than being
inferred from surviving lines.

**Why 5 and 6 matter.** Both were found by `assertNothingDropped`, which exists
only because the spec asked for it. Without that assertion, entities would have
silently disappeared from the pipeline and the residue count would have been
quietly wrong. The assertion cost about forty lines and found two bugs neither a
type checker nor a passing scorer would have surfaced.

## 7 — `ORDER_WITHOUT_SETTLEMENT` could never fire

**Symptom.** Its count was 0 in every run.

**Root cause.** Duplicate-webhook twins are paid orders with no settlement line —
exactly the condition the code tests. But the duplicate handler claimed those
orders first and `continue`d past the check, so the only records that could
trigger it were already consumed.

**Fix.** [`src/lib/match/orderPayment.ts`](src/lib/match/orderPayment.ts) — the
unsettled twin now also emits `ORDER_WITHOUT_SETTLEMENT`. Both codes land on the
same residue entry, which is richer for the classifier than either alone.

**Why it mattered.** A finding code that cannot fire looks identical to a finding
code that found nothing. Only auditing the counts against the taxonomy caught it.

## 8 — Cross-tab attribution muddied at volume

**Symptom.** At `--orders 5000` the finding-type vs true-cause table showed
`FEE_SLAB_MISMATCH` against `LATE_SETTLEMENT` and `ON_HOLD` — combinations that
make no sense.

**Root cause.** Attribution was per *residue entry*. Entries are connected
components, so an on-hold batch absorbs many unrelated findings, and every
finding in the component inherited every label in it.

**Fix.** [`scripts/scoreMatch.ts`](scripts/scoreMatch.ts) — attribution is per
*finding*, over the entities that finding actually fired on. This required
serialising a small per-entry `findings` array. The table is now exactly
diagonal except the one genuinely ambiguous row.

**Why it mattered.** The whole purpose of that table is to separate real signal
from boundary noise. A muddied version would have understated precision and
hidden which finding types are actually reliable.

## 9 — Python banker's rounding faked nine false positives

**Symptom.** A throwaway detector reported one unlabelled `FEE_VARIANCE` false
positive on 9 of 42 seeds. It looked like a data defect.

**Root cause.** The generator uses JavaScript `Math.round` (half up). My
verification script used Python's `round` (half to even). They disagree on
exact `.5` cases.

**Fix.** Test script only; no product change.

**Why it is logged.** For about ten minutes I believed the dataset was wrong. The
failure was in the instrument, not the subject. Worth recording because a
verification tool that disagrees with its subject over a rounding convention
will manufacture defects indefinitely, and the natural instinct is to "fix" the
thing being measured.

## 10 — Torn JSONL line survived every rerun

**Symptom.** After simulating a crash mid-write, the resume worked — but the
half-written line stayed in the file permanently, and `scoreClassify.ts` would
have thrown on it.

**Root cause.** The loader tolerated an unparseable line on read but never
removed it, and appends went after it. Read-tolerance without write-repair means
the artefact stays corrupt forever.

**Fix.** [`src/lib/classify/run.ts`](src/lib/classify/run.ts) — the file is
compacted from the records that parsed before any append, so it is always valid
JSONL. The scorer also tolerates and reports unparseable lines, as defence in
depth.

## 11 — Resume treated transport failures as done

**Symptom.** A live Gemini call failed on a quota block. The failure was written
to `classifications.jsonl` as a record, and the next run skipped that entry as
"already classified".

**Root cause.** Resumability keyed on "is there a row for this id" rather than
"did the model actually produce a verdict".

**Fix.** [`src/lib/classify/run.ts`](src/lib/classify/run.ts) —
`isResumable()`: a `transport_failure` is never resumable, because the model
never saw the case. A `schema_failure` *is* a real verdict (the model was asked
twice) and is only redone with `--retry-failed`.

**Why it mattered.** This is the worst bug in this log. A run interrupted by an
outage, a rate limit or a billing block would leave permanent holes that every
subsequent run skipped in silence, and the score would have been computed over
an incomplete set that looked complete. It was found only because a real API
failed for real.

## 12 — Env var read before `.env` was loaded

**Symptom.** `GEMINI_THINKING_BUDGET` never took effect.

**Root cause.** It was read at module load. ESM imports hoist above the
`loadDotEnv()` call in `main()`, so `process.env` was not yet populated.

**Fix.** [`src/lib/classify/config.ts`](src/lib/classify/config.ts) — every env
read is a function called at construction time, not a module-level constant.

## 13 — Partial-run ceiling message was incoherent

**Symptom.** A truncated run printed: *"3 residue entries bundle two real
defects, so 14/40 is the maximum achievable here."* The premise and the
conclusion were unrelated numbers.

**Root cause.** The ceiling was computed over classified entries while the
explanation counted bundled entries across all of them.

**Fix.** [`scripts/scoreClassify.ts`](scripts/scoreClassify.ts) — a partial run
now says so plainly and states that its scores are not comparable to a full run.
The taxonomy ceiling is only reported when the run is complete.

**Why it mattered.** The number was right; the sentence explaining it was
misleading. In a report whose entire job is to be trusted, that is a defect.

## 14 — The build guard failed on its own documentation

**Symptom.** `checkIsolation.ts` reported `src/lib/match/run.ts: reads
labels.json` on its first run.

**Root cause.** It scanned raw file text for forbidden strings. The doc comment
saying *"never reads labels.json"* matched.

**Fix.** [`scripts/checkIsolation.ts`](scripts/checkIsolation.ts) — a small
tokenizer strips comments (respecting string and template literals) before
scanning, so the guard reads code, not prose.

**Why it mattered.** A guard with false positives gets disabled. Making it
precise was the difference between a build gate and an annoyance.

## 15 — Decision bar overlapped the content it acts on

**Symptom.** The sticky decision bar covered the proposed adjusting entry — the
figure the reviewer is deciding about.

**Root cause.** `position: sticky` inside the scrolling container let content
slide underneath.

**Fix.** [`src/app/globals.css`](src/app/globals.css) — the detail pane is a
fixed grid (`1fr auto`) with the scroll area and the bar as siblings. Nothing can
slide under anything.

## 16 — Long identifiers overflowed their column

**Symptom.** Comma-joined order ids and bank descriptions ran past their card
edges.

**Fix.** [`src/app/globals.css`](src/app/globals.css) — `overflow-wrap: anywhere`
and an explicit max width on ledger and card values.

## 17 — Merged evidence keys rendered as mangled prose

**Symptom.** A field labelled **"ORDER WITHOUT SETTLEMENT.amount"**.

**Root cause.** When findings merge, the matcher namespaces colliding evidence
keys as `FINDING_CODE.key`. The humanizer split on underscores and knew nothing
about the dot.

**Fix.** [`src/app/ReviewClient.tsx`](src/app/ReviewClient.tsx) — `splitScope()`
separates the code from the field, so it reads **"Amount"** with a muted *"from
ORDER_WITHOUT_SETTLEMENT"* qualifier beneath.

**Why 15–17 matter.** All three passed `tsc --noEmit` and all three would have
passed any test that asserted on the DOM. They were found by rendering the page
and looking at it. A screenshot is a test.

---

## 18 — The output schema discarded a second real defect

**Symptom.** Classifier accuracy sat at 37/40 and would not move. Rewording the
prompt changed nothing, which is the signal that the problem is not the prompt.

**Root cause.** Three residue entries each carry *two* real defects: a
`DUPLICATE_WEBHOOK` order pair whose settled twin sits inside an `ON_HOLD` batch.
The model did not miss the second one — in all three cases it named the duplicate
pair in its `reasoning`, once by the literal cause name (*"While there is a
DUPLICATE_WEBHOOK between order_pq2uzwovet26mz and order_vtjf1cub68hjo8, the
ON_HOLD status is a settlement-level cause that takes precedence"*). But
`predicted_cause` is a single enum. The second label had nowhere to go and was
dropped at the schema boundary, and scoring, routing and the proposed adjusting
entry all read that one field. Two of the three were then auto-approved at
confidence 1.00.

**Fix.** Not applied. This one is structural, and patching it in the prompt would
only hide it: no wording can return two labels through a field that holds one.
`predicted_cause` has to become a ranked list, with the scorer crediting a
correct secondary cause and the UI rendering it. Left in place, and quantified,
because a known ceiling that is measured is worth more than a silent one that is
worked around. The scoring harness already reports exactly what the fix would
recover: three defects, 37/40 → 40/40.

**Caught by.** The scorer's own ceiling analysis, then confirmed by reading the
raw `classifications.jsonl` line by line. Neither the type checker nor a passing
score would have shown it — accuracy of 37/40 reads as ordinary model error
until you notice the same three entries are unreachable by construction, and
that the model had in fact answered correctly in prose.

---

## 19 — Resume skipped a run it had never done

**Symptom.** In a clean clone, `classify.ts --seed 42 --provider rules` printed
`provider: rules-baseline`, reported all 43 cases "skipped (already classified)",
and exited 0. `scoreClassify.ts` then reported `provider=gemini`. The offline,
no-API-key path documented in the README had produced nothing at all.

**Root cause.** Resume was keyed on `residue_id` alone. The repo ships a
completed Gemini run as `classifications.jsonl`, so every id was already present
and every entry was skipped — while the header still announced the requested
provider. Both providers emit the same cause distribution, so the run summary
looked identical to a real one. Nothing was wrong on screen except the one line
naming the provider, 43 lines above the answer.

**Fix.** [`src/lib/classify/run.ts`](src/lib/classify/run.ts) — `matchesProvider`
compares provider *and* model, and `assertSingleProvider` refuses to append one
provider's results onto another's, exiting non-zero with the two ways out
(`--fresh` to overwrite, `--dir` to keep both). It throws rather than discarding
the existing file, because that file is a completed run someone paid for in
tokens. Added `--fresh`, which required teaching `parseArgs` bare boolean
switches, and `--file` on the scorer so the rules baseline can be scored in place
without moving anything.

**Caught by.** A pre-submission clean-clone rehearsal — cloning the public repo
and running the documented commands in order, as a reader would. Nothing in the
working tree could have shown it, because the working tree already had the file
in the state the developer expected. The generalisation: *the artefacts a repo
ships are part of its behaviour*, and a path only exercised on a machine that
already ran it is a path never tested.

---

## Not code defects: environment failures encountered live

Recorded because each one blocked a run and each was diagnosed from the API's
own error rather than guessed at.

| Failure | Response | Resolution |
|---|---|---|
| Anthropic account at zero balance | `400 invalid_request_error — "Your credit balance is too low"` | Switched provider; the key itself was valid (a bad key returns 401) |
| `gemini-2.5-flash` retired | `404 NOT_FOUND — "no longer available to new users … use models/gemini-3.6-flash"` | Default model changed, kept overridable |
| `thinkingBudget: 0` rejected | `400 INVALID_ARGUMENT` | Thinking config omitted unless explicitly set; `maxOutputTokens` raised to 8192 since thinking shares the budget |
| Gemini free tier daily cap | `429 RESOURCE_EXHAUSTED — GenerateRequestsPerDayPerProjectPerModel-FreeTier, limit: 20` | 43-entry batch is impossible on that model; moved to `gemini-3.1-flash-lite`, which has its own quota |

The 20-per-day cap is worth noting: no published source I checked stated it, and
Google no longer publishes a universal rate-limit table. The only reliable source
was the error body itself. Backoff absorbed 71 retries before I stopped the run —
correct behaviour, but backoff cannot manufacture quota, and a retry policy that
cannot distinguish "wait" from "you are out" will burn an afternoon politely.

---

## What actually caught things

| Mechanism | Bugs found | Cost to build |
|---|---|---|
| Multi-seed sweep (42 seeds) | 1, 2, 5, 6 | ~10 lines of shell |
| `assertNothingDropped` partition check | 5, 6 | ~40 lines |
| Auditing finding counts against the taxonomy | 7 | manual, one pass |
| Deliberate crash / interruption tests | 10, 11 | ~20 lines of test |
| Screenshotting the rendered page | 15, 16, 17 | one browser call |
| Reviewer reading the code | 3, 4 | free, and the highest-value pair |
| Scoring against ground truth | 18 | the reason labels exist |
| Clean-clone rehearsal of the docs | 19 | one clone, six commands |
| A real API failing for real | 11, 12 | unavoidable |

Type checking found none of the nineteen. A *passing* scorer found none of the
first seventeen — every one of them survived a green run. The exceptions are 18,
and only because the scorer reports a ceiling rather than a percentage: 37/40
alone looks like ordinary model error, and it is the "3 entries bundle two real
defects" line underneath it that turns a number into a diagnosis — and 19, which
no amount of scoring could have found, because it only appears on a machine that
has not already run the thing.

The two most valuable checks were still the cheapest: run it on more than one
input, and assert that nothing disappears.
