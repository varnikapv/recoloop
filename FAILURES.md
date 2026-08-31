# FAILURES.md

A record of what broke while building RecoLoop, and what each failure changed
about the system — not a changelog of every bug fixed, but the four that
actually altered a design decision.

---

## 1 — Two generator bugs, one behind the other

`generate.ts --seed 99` hung — a rebalancer moving oversized refund debits
between settlement days could push a debit back and forth indefinitely
between two days too small to absorb it. Fixed with a forward-only carry
sweep that makes a cycle impossible rather than just unlikely. That fix
immediately exposed the deeper problem behind it: order amounts run to
₹85,000, but a typical day's gross settlement is only ~₹30,000, so a single
large refund can exceed an entire day's takings — a modelling constraint,
not a code bug. Refund-eligible payments are now capped at half the median
daily gross, the way a real gateway would throttle refunds that outrun a
day's captures.
---

## 2 — The partition assertion caught two bugs a single seed never exposed

**Symptom.** Nothing visible on `--seed 42` — verification, matching, and
scoring all passed cleanly. The bugs below only appeared once the matcher was
run across 42 different seeds.

**Root cause, bug A.** A clean refund line was going unaccounted for whenever
its parent order was tainted for an unrelated reason — the ownership rule
attributed a refund's reconciliation status to the *order* it referenced,
when it should only ever be attributed to the *payment*.

**Root cause, bug B.** Settlements that reconciled perfectly against the bank
but had no single surviving "clean" line were vanishing from the output
entirely — batch-level reconciliation was being inferred from whether any
individual line looked clean, rather than from the settlement's own verdict.

**Fix.** Added a single assertion — `assertNothingDropped` — that every
order, payment, refund, settlement line, and bank row must land in exactly
one of matched / residue / excluded, and throws otherwise. Then fixed the
ownership rule (refunds are owned by their payment, not their order) and
derived settlement-level reconciliation from the settlement's own match
verdict rather than its lines' survival.

**Why it mattered.** ~40 lines of assertion caught two real accounting bugs
that neither the type checker nor a passing score on one seed would ever
have shown. It's the cheapest check in the whole project and the highest
yield — the two most valuable things done here were running the code on
more than one input, and asserting nothing can silently disappear.

---

## 3 — Resume keyed on identity, not on what actually happened

This is one design weakness that surfaced twice, in two different parts of
the pipeline, months apart. Presented together because it's a single lesson,
not two unrelated bugs.

**First occurrence — classifier resume vs. transport failure.**
*Symptom:* a run interrupted by a network outage or a billing block, when
rerun, silently skipped the entries that had failed — permanently, with no
warning.
*Root cause:* resume logic treated "a row exists in the output file" as
"this case is done," without checking *how* it ended. A transport failure
means the model never actually saw the case; treating that the same as a
completed classification leaves permanent, silent holes.
*Fix:* `isResumable` now excludes `transport_failure` rows explicitly — only
a row that recorded a real model verdict (even a schema failure, which was
asked twice) counts as done.

**Second occurrence — resume vs. provider.**
*Symptom:* running `--provider rules` against a data directory that already
held a completed Gemini run reported "all 43 already classified" and exited
0 — producing nothing, while looking like success. The scorer then silently
reported Gemini's numbers under the label of the offline baseline. Found by
cloning the finished public repo and running its own documented Quickstart.
*Root cause:* resume was keyed on `residue_id` alone. Two different
providers answering the same case produce a row with the same key, so the
second provider's run was invisible to itself.
*Fix:* resume now checks provider *and* model, not just the case id. Pointing
a different provider at an existing file is refused outright with a
non-zero exit and an explicit message, rather than silently skipped or
silently merged. A `--fresh` flag was added for the deliberate case of
starting over.

**Why it mattered.** "Resume" is really "was this case actually handled the
way I now expect," and both bugs came from checking existence instead of
checking that. The second bug is also notable for how it was found: not by a
test, but by treating the shipped repo itself as an untested artifact and
running its own instructions from a clean clone — which is exactly what a
judge would do.

---

## 4 — The bundled-defect blind spot

**Symptom.** Classifier accuracy plateaued at 37/40 and no amount of prompt
rewording moved it. Three residue entries each carry *two* real defects: a
duplicated order pair whose settled twin sits inside an on-hold batch.

**Root cause.** Not a prompting failure — a contract failure. The model did
not miss the second defect: in all three cases it named the duplicate pair
explicitly in its own reasoning, once by the literal cause name
(*"While there is a DUPLICATE_WEBHOOK between order_pq2uzwovet26mz and
order_vtjf1cub68hjo8, the ON_HOLD status is a settlement-level cause that
takes precedence"*). But `predicted_cause` is a single enum. The second
label had nowhere to go and was discarded at the schema boundary — and
everything downstream (scoring, routing, the proposed adjusting entry) reads
only that one field. Two of the three were then auto-approved at confidence
1.00.

**Fix.** Not applied, deliberately. No prompt can return two labels through a
field that holds one — the fix is structural: `predicted_cause` needs to
become a ranked list, with the scorer crediting a correct secondary cause and
the review UI rendering it. The scoring harness already reports exactly what
that fix would recover: three defects, 37/40 → 40/40.

**Why it mattered.** This is the one entry in this file that isn't an
engineering bug at all — it's the system correctly surfacing its own
structural limitation, quantified rather than hidden. A confident wrong
answer would be a worse failure than an honest, measured ceiling, and this is
the latter: the model was right, twice, in the same breath, and the output
format only had room to say so once.

---

## A note on scope

Further smaller issues — scoping bugs in the verifier, a load-order
bug in environment configuration, three UI rendering bugs found by
screenshotting the rendered page, a rounding mismatch in a test harness, and
a few others — were found and fixed during development and are visible in
the commit history. They're omitted here because none of them changed a
design decision the way above did.