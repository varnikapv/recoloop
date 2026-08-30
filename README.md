# RecoLoop — synthetic reconciliation dataset

The data foundation for a payment reconciliation system. It generates a
realistic three-source dataset (merchant orders, gateway settlement report,
bank statement) that has been deliberately seeded with **labelled defects**, so
a matcher built later can be scored against ground truth.

This repo contains the generator, the verifier and a bare Next.js shell. There
is no matcher, no UI and no LLM integration here — by design.

```
src/lib/types.ts       domain model
src/lib/rng.ts         mulberry32 PRNG + seeded helpers
src/lib/money.ts       integer-paise arithmetic, Indian rupee formatting
src/lib/dates.ts       UTC date handling and the two statement date formats
src/lib/csv.ts         CSV writer/reader + the id normalisation rule
src/lib/ids.ts         id minting and the "dirt" applied to id fields
src/lib/defects.ts     defect taxonomy and distribution scaling
src/lib/generate.ts    the generator
src/lib/emit.ts        CSV rendering (this is where dirt is applied)
src/lib/labels.ts      the ONLY module that reads labels.json
scripts/generate.ts    CLI
scripts/verify.ts      CLI

src/lib/normalize.ts          matcher stage 0
src/lib/match/orderPayment.ts       stage 1  (pure)
src/lib/match/paymentSettlement.ts  stage 2  (pure)
src/lib/match/settlementBank.ts     stage 3  (pure)
src/lib/match/delay.ts              stage 4  (pure)
src/lib/match/residue.ts      residue assembly (pure)
src/lib/match/run.ts          orchestration + all matcher I/O
scripts/match.ts              CLI
scripts/scoreMatch.ts         CLI — scores against ground truth
scripts/checkIsolation.ts     build guard: the matcher cannot reach the labels

src/lib/classify/config.ts        every tunable, in one place
src/lib/classify/schema.ts        Zod contract; the tool schema is derived from it
src/lib/classify/prompt.ts        system prompt + per-case brief
src/lib/classify/provider.ts      Anthropic transport, tool-use, backoff
src/lib/classify/rulesProvider.ts offline deterministic baseline
src/lib/classify/run.ts           retries, confidence gate, resumable writes
scripts/classify.ts               CLI
scripts/scoreClassify.ts          CLI — scores against ground truth

src/lib/ui/review.ts          UI data access (scanned by checkIsolation)
src/app/api/review/route.ts   GET payload / POST one audit entry
src/app/page.tsx              server component, request-time read
src/app/ReviewClient.tsx      queue / detail / decision bar
src/app/globals.css           design tokens
```

## Quickstart

```bash
npm install
npx tsx scripts/generate.ts --seed 42 --orders 500 --defects 40
npx tsx scripts/verify.ts   --seed 42 --defects 40
```

Both scripts accept `--out` / `--dir` to point at a directory other than
`data/<seed>/`. `npm run generate` and `npm run verify` are equivalent
shortcuts.

## Determinism

Everything random comes from `mulberry32`, seeded from `--seed`. A given
`(seed, orders, defects)` triple produces **byte-identical** files on every run,
including the 30-day calendar window, which is anchored at `2025-05-01T00:00:00Z`.
CSV "dirt" is drawn from a separate stream derived from the same seed, so
changing the dirt model can never shift the underlying data.

## The money rule

Every amount is an **integer number of paise**. Fee rates are stored as basis
points (`upi 0, card 200, netbanking 180, wallet 220`) so the fee computation is
integer arithmetic end to end:

```
fee_paise = round(amount_paise * bp / 10_000)
tax_paise = round(fee_paise * 18 / 100)
```

No float ever reaches a stored value. The only place rupees-with-decimals
appear is the bank statement's *rendering* (`"1,24,530.00"`), which the reader
parses straight back to integer paise.

## Output

`data/<seed>/` — three CSVs a downstream consumer is allowed to see, and one
JSON file it is not.

### `orders.csv` — the merchant's internal order ledger

| column | notes |
| --- | --- |
| `order_id` | `order_` + 14 lowercase alphanumerics |
| `amount_paise` | integer |
| `currency` | always `INR` |
| `created_at` | ISO-8601 UTC, second precision |
| `status` | `paid` \| `pending` \| `cancelled` |

Sorted by `created_at`. Note the row count can exceed `--orders`: a
`DUPLICATE_WEBHOOK` defect writes an extra ledger row for a payment that only
happened once.

### `settlement_report.csv` — settlement lines joined to their settlement header

Mirrors the shape of Razorpay's recon report: one row per settlement line, with
the settlement header repeated across every line of the batch.

| column | notes |
| --- | --- |
| `entity_id` | the payment / refund / adjustment id this line settles |
| `type` | `payment` \| `refund` \| `adjustment` |
| `order_id`, `payment_id` | join columns; blank on adjustments |
| `method` | `upi` \| `card` \| `netbanking` \| `wallet`; blank on non-payment lines |
| `currency` | `INR`; blank on adjustments |
| `debit_paise`, `credit_paise` | one of the two is zero |
| `amount_paise`, `fee_paise`, `tax_paise` | gross, fee and GST on the fee |
| `settlement_id`, `settled_at` | batch identity |
| `settlement_utr` | 12-digit numeric string; the only handle the bank gives you |
| `settlement_status` | `processed` \| `on_hold` |
| `settlement_net_amount_paise`, `settlement_fee_paise`, `settlement_tax_paise` | batch header, repeated |
| `settlement_created_at` | batch header, repeated |

Sorted by `settled_at`, then `settlement_id`, then `entity_id`.

> `order_id` and `method` are **not** in the real Razorpay recon report — see
> [Stated assumptions](#stated-assumptions) below.

A payment line credits `amount − fee − tax`. A refund or adjustment line debits
its full amount. The batch invariant is exact:

```
settlement.net_amount_paise = Σ line.credit_paise − Σ line.debit_paise
```

### `bank_statement.csv` — one row per bank movement

| column | notes |
| --- | --- |
| `bank_txn_id` | `txn` + 12 digits |
| `value_date` | **alternates** between `DD/MM/YYYY` and `YYYY-MM-DD` |
| `description` | free text carrying the UTR (three formats, chosen at random) |
| `credit`, `debit` | rupee strings with Indian grouping, e.g. `"1,24,530.00"`; blank when zero |
| `running_balance` | same format, from an opening balance of ₹2,50,000 |

Sorted by `value_date`, then `bank_txn_id`. The bank **never itemises
individual payments** — a processed settlement appears as exactly one credit
equal to its net amount, and the only link back to the report is the UTR
embedded in the description.

### `labels.json` — ground truth

```json
[{ "record_type": "...", "record_id": "...", "true_cause": "...", "note": "..." }]
```

**This is the only copy of the ground truth.** No `true_cause` field, no defect
marker and no ordering tell exists in the three CSVs; all three are sorted
chronologically, and the injected records are interleaved with clean ones. A
matcher that reads only the CSVs is structurally incapable of seeing the
answers. `scripts/verify.ts` enforces this.

## Stated assumptions

Two places where this dataset knowingly departs from the real gateway API. Both
are choices, not oversights.

### 1. The settlement report carries `order_id` and `method`

Razorpay's settlement recon report carries `entity_id`, which links each line to
its payment. `payment_id` here is faithful to that. **`order_id` and `method`
are additions and are not documented in the actual API.**

The assumption they encode: *the merchant's own order system enriches the recon
feed with `order_id` and `method` at ingestion time*, before it reaches the
reconciliation pipeline. That is a normal thing for a merchant to build — the
gateway's payment id is the natural join key back into their own order table —
but it is an assumption about the merchant's stack, not a property of the
gateway's output.

**Does this make matching too easy?** No. It makes `PARTIAL_CAPTURE`,
`SILENT_UPI_FAIL` and `FEE_VARIANCE` *detectable*; it does not perform the
match. The hard part is untouched: grouping N settlement lines into one
settlement, reconstructing that batch's net, and tying it to a **single** bank
credit through nothing but a UTR buried in free text, under date tolerance. The
join columns feed classification context after the match, not the match itself.
Strip them and three defect classes become undetectable in principle, which
would make the labelled dataset unscoreable rather than harder.

### 2. Debits are bounded so a batch is never a net debit

A real settlement batch is never a net debit, but an ₹85,000 refund against a
day whose gross credits total ~₹30,000 would make one. The generator therefore
caps debits at half the median daily gross credit — which excludes only the
largest tickets from the refund pool — and sweeps the days forward once,
carrying any debit a batch cannot absorb into the next batch. That carry is what
a gateway actually does when a day's refunds outrun its captures.

## Generation rules

- 500 orders over a 30-day window (`--orders` changes the count).
- Amounts are log-normal (median ≈ ₹700), clamped to ₹99–₹85,000, so the mass
  sits at small tickets with a long right tail.
- Method mix: `upi 62%`, `card 24%`, `netbanking 9%`, `wallet 5%`.
- Order status mix: `paid 90%`, `pending 6%`, `cancelled 4%`. Only `paid` orders
  produce a captured payment; some pending/cancelled orders carry an
  `authorized` or `failed` payment, which never settles and therefore never
  appears in the settlement report.
- ~4% of captured payments are refunded 1–9 days later, 60% in full (which flips
  the payment to `refunded`) and 40% partially.
- **Batching:** a payment settles `T+2` from capture, a refund `T+2` from its
  creation, grouped into one settlement per calendar day, settled at 05:30 UTC
  (11:00 IST). Refunds and adjustments falling in a batch's window are netted
  into it.
- **Bank:** every `processed` settlement produces exactly one credit row equal
  to its net; `on_hold` settlements produce nothing.

## Dirt (noise, not defects)

Real recon inputs are filthy. The following is applied uniformly at random,
never correlated with a defect, and exists so the normaliser has real work:

- `value_date` alternates between `DD/MM/YYYY` and `YYYY-MM-DD`, row by row.
- ~8% of id cells across all three files carry leading/trailing whitespace
  and/or mixed case. Ids are minted lowercase, so `trim().toLowerCase()` is a
  lossless normalisation (`normaliseId` in `src/lib/csv.ts`).
- Bank amounts are strings with Indian digit grouping and two decimals.

## Defect taxonomy

Exactly 40 defects at the default settings, each with one label record. **A
record carries at most one defect.** Selection is seeded and reproducible.

| cause | n | labelled record | what it does to the data |
| --- | --- | --- | --- |
| `LATE_SETTLEMENT` | 7 | `payment` | Captured inside the window but settled `T+5` instead of `T+2`, landing two cycles from where the merchant expects it. |
| `REFUND_NETTED` | 6 | `refund` | A refund against a payment from a **prior cycle** is netted into this settlement. Neither that payment nor its order exists anywhere in the dataset, so the line has nothing to trace back to. |
| `PARTIAL_CAPTURE` | 5 | `payment` | `payment.amount_paise < order.amount_paise`, so order-to-settlement amount matching misses. |
| `FEE_VARIANCE` | 5 | `payment` | Fee billed at a rate 0.4 percentage points off the method's slab, so reconstructing net from gross misses by a small delta. |
| `ON_HOLD` | 4 | `settlement` | `settlement_status = on_hold`; the batch is in the report but **no bank credit row exists at all**. |
| `DUPLICATE_WEBHOOK` | 4 | `order` | The same payment is written into the order ledger twice under two `order_id`s — same amount, timestamps within 90 seconds. Only one of them ever settles. |
| `SILENT_UPI_FAIL` | 4 | `order` | Payment is `captured` and settles, but its order is still `pending` — the success callback was lost. |
| `CHARGEBACK_DEBIT` | 3 | `settlement_line` | An `adjustment` line with a debit and no matching entity in orders or payments. |
| `UNEXPLAINED` | 2 | `bank_txn` | A bank credit whose UTR appears in no settlement. |

`--defects N` scales this distribution to `N` using the largest-remainder
method, deterministically. The generator errors out with an actionable message
if a category's eligible pool is too small for the request.

## Verifier

```bash
npx tsx scripts/verify.ts --seed 42 --defects 40
```

Reads the dataset back the way a consumer would — through the CSVs, with
normalisation — prints a pass/fail table plus a per-cause conformance
breakdown, and exits non-zero on any failure.

The verifier **imports no business logic from the generator**, only parsing
helpers. Every rate, constant and invariant it checks is restated independently
from the contract documented above, so a bug in the generator cannot hide inside
a helper both sides call.

| check | assertion |
| --- | --- |
| settlement net | **every** settlement's net equals the sum of its lines. No defect in the taxonomy perturbs this invariant, so it is asserted over the whole population rather than a clean subset |
| fee reconstruction | rebuilding each batch's net from gross amounts and the *published* fee slabs. Every settlement either reconstructs exactly, or misses by **precisely** the delta its `FEE_VARIANCE` labels predict |
| ground-truth conformance | every one of the 40 labels manifests in the CSVs exactly as its taxonomy entry says, and **nothing unlabelled looks defective**. The detectors read only the three sources, never `labels.json` |
| bank match | every `processed` settlement has exactly one bank credit for its UTR, equal to its net; every `on_hold` settlement has none |
| running balance | the statement's running balance is internally consistent from the ₹2,50,000 opening |
| label count | `labels.json` holds exactly `--defects` labels |
| label integrity | every label resolves to a record that exists, and no record carries two defects |
| no leak | no cause token and no label note appears in any CSV cell or header |
| no ordering tell | all three sources are sorted by their own timestamp column |
| integer money | every `*_paise` column and every parsed bank amount is integral |

The first three are the coverage story. Between them, every settlement is
checked — either for exact correctness, or for the exact expected deviation —
and every injected defect is proven to be both present and findable:

```
PASS  settlement net == sum(credit) - sum(debit)           30/30 settlements balance exactly, incl. all 25 carrying an injected defect
PASS  net reconstructs from published fee slabs            26 settlement(s) reconstruct exactly, 4 deviate by exactly the injected delta (-269 paise total)
PASS  every defect manifests exactly as its taxonomy says  40/40 labels recovered from the CSVs alone, 0 false positives
```

## Matcher

```bash
npx tsx scripts/match.ts      --seed 42   # writes match_result.json + normalize_log.json
npx tsx scripts/scoreMatch.ts --seed 42   # scores it against labels.json
```

Deterministic, pure, synchronous. Same input files produce a byte-identical
`match_result.json`. Stages 1–4 are `(normalized records) -> findings` with no
I/O; `src/lib/match/run.ts` does all reading and writing.

### Label isolation is a build failure, not a convention

`src/lib/labels.ts` is the only module that reads `labels.json`.
`scripts/checkIsolation.ts` walks the static import graph from the matcher's
entry points and fails if it can reach that loader, the defect taxonomy, or a
literal mention of `labels.json`. It is wired into `npm run build`, so a stray
import breaks the build:

```
$ npm run build          # with an import of ../labels added to a matcher module
matcher isolation VIOLATED:
  src/lib/labels.ts: labels loader is reachable from the matcher
  ...
exit 1
```

`scripts/scoreMatch.ts` is the only matcher-pipeline script permitted to read the
labels. (`scripts/verify.ts` also reads them, through the same loader — checking
that the ground truth has not leaked into the CSVs is its job.)

### Stages

| stage | file | what it does |
| --- | --- | --- |
| 0 | `normalize.ts` | trims/lowercases ids, accepts both date formats, parses `"1,24,530.00"` **as a string** into integer paise (never `parseFloat`), and pulls the 12-digit UTR out of the three known description shapes. Anything that matches no known shape throws with the raw value attached. Corrections are counted by field and persisted to `normalize_log.json`. |
| 1 | `orderPayment.ts` | joins orders to payment lines. Two orders with identical amounts created within 90s are treated as candidates for the **same** underlying payment — the matcher never picks one; both go to residue together. |
| 2 | `paymentSettlement.ts` | resolves each settlement line to the merchant's records, and compares captured amount and fee against the order and the published slab. |
| 3 | `settlementBank.ts` | groups lines by `settlement_id`, reconstructs the batch net, and ties it to a single bank credit through the UTR with ±1 paise tolerance. |
| 4 | `delay.ts` | computes the actual settlement day-delta for every settled line and carries it as evidence. T+2 is never a hard boundary. |

### Finding codes

The first nine are the specified codes. **The last three are additions** —
without them, three defect classes in this dataset have no code that can ever
fire, and would be silently auto-matched as clean (capture would be 27/40):

| code | fires on |
| --- | --- |
| `DUPLICATE_ORDER_PAIR` | two order rows, same amount, ≤90s apart |
| `ORDER_WITHOUT_SETTLEMENT` | a `paid` order with no settlement line |
| `ORPHAN_SETTLEMENT_LINE` | a line with no counterpart in the merchant's records |
| `SHORT_CAPTURE` | captured amount below the order amount |
| `SETTLEMENT_DELAY` | day-delta above T+2, carrying the exact delta |
| `SETTLEMENT_WITHOUT_BANK_CREDIT` | processed batch, no bank row for its UTR |
| `BANK_CREDIT_WITHOUT_SETTLEMENT` | bank credit whose UTR is in no settlement |
| `NET_MISMATCH` | batch net vs bank credit outside tolerance |
| `UNEXPECTED_BANK_CREDIT_ON_HOLD` | held batch that nonetheless got paid |
| **`FEE_SLAB_MISMATCH`** | fee/tax off the published slab — the only signal `FEE_VARIANCE` leaves |
| **`SETTLEMENT_ON_HOLD`** | held batch: money owed that never arrived, so it cannot be called reconciled |
| **`ORDER_STATUS_CONTRADICTION`** | settled payment against an order still `pending` |

### Nothing is ever silently dropped

Every order, settlement line, settlement and bank row lands in exactly one of
`matched`, a residue entry's `entities`, or `excluded`. `assertNothingDropped`
in `run.ts` checks the partition on every run and throws on any entity that is
unaccounted for or double-counted. It has already caught two real bugs.

Ownership rules that make the partition well-defined:

- Only a **payment** line's matched record claims its order — an order is
  reconciled by its own payment, never by a refund raised against it.
- A **batch** that reconciled against its bank credit is matched even when its
  individual lines are separately disputed (`reconciled_settlements`).
- Line-level findings own the line and its order; settlement-level findings own
  the batch, all its lines, and their orders. Related-but-not-owned ids travel
  in `evidence`.

### Deviations from the specified output schema

- **`excluded`** is a third bucket, alongside `matched` and `residue`. A
  `cancelled` order with no payment is correctly reconciled — it expected no
  money and saw none. Putting those ~41 rows in residue would be analytically
  wrong and would wreck the match rate. The partition assertion covers all three.
- **`entities` uses arrays** (`orders`, `settlement_lines`, `settlements`,
  `bank_txns`) rather than singular keys, because a duplicate pair owns two
  orders and a held batch owns many lines. Payments and refunds *are* settlement
  lines in this dataset, so they live under `settlement_lines`.
- Added: `reconciled_settlements`, `reconciled_bank_txns`, `day_delta_histogram`,
  a per-entry `findings` array (code + the entity ids it fired on, for exact
  attribution), and `line_id` / `line_type` on matched records.

### Results at `--seed 42`

```
DEFECT CAPTURE RATE: 40/40  — every labelled defect reached residue

measure                                   value
clean records auto-matched                802/959
clean auto-match rate                     83.63%
residue entries                           43
residue entries containing a real defect  37/43 (86.0%)
overall match rate by count               89.81%
overall match rate by value               73.66%
```

The cross-tab is exact — attributed per finding, over the entities that finding
actually fired on:

```
finding_type                    ...  LATE_SETTLEMENT  ...  noise
BANK_CREDIT_WITHOUT_SETTLEMENT                     0           0    (2 UNEXPLAINED)
DUPLICATE_ORDER_PAIR                               0           0    (4 DUPLICATE_WEBHOOK)
FEE_SLAB_MISMATCH                                  0           0    (5 FEE_VARIANCE)
ORDER_STATUS_CONTRADICTION                         0           0    (4 SILENT_UPI_FAIL)
ORPHAN_SETTLEMENT_LINE                             0           0    (3 CHARGEBACK + 6 REFUND_NETTED)
SETTLEMENT_DELAY                                   7           7
SETTLEMENT_ON_HOLD                                 0           0    (4 ON_HOLD)
SHORT_CAPTURE                                      0           0    (5 PARTIAL_CAPTURE)
```

Every finding type is perfectly precise except `SETTLEMENT_DELAY`: 7 true
`LATE_SETTLEMENT` against 7 pieces of boundary noise. That noise is structural,
not a bug — `captured_at` is published in none of the three sources, so the
delta has to be measured from the order's `created_at`, and a capture that
crossed midnight relative to its order reads as T+3. Stage 4 carries the exact
delta rather than collapsing it to a verdict, which is precisely what lets a
later classifier separate a T+3 boundary case from a T+5 late settlement.

`NET_MISMATCH`, `SETTLEMENT_WITHOUT_BANK_CREDIT` and
`UNEXPECTED_BANK_CREDIT_ON_HOLD` never fire on this dataset. That is correct:
the settlement report is internally consistent by construction, so no defect in
the taxonomy can make a batch net disagree with its own lines.

### Known precision limit

The duplicate-order heuristic (identical amount, ≤90s apart) degrades with order
density. At `--orders 5000` it produces 20 `DUPLICATE_ORDER_PAIR` findings for 12
real `DUPLICATE_WEBHOOK` defects — 8 coincidental collisions. Capture stays
120/120; the cost is precision, not recall, which is the right direction for a
stage that feeds a classifier.

## Classifier

```bash
cp .env.example .env   # then put your key in it; .env is gitignored, never commit it
npx tsx scripts/classify.ts      --seed 42                     # default provider (anthropic)
npx tsx scripts/classify.ts      --seed 42 --provider gemini   # Gemini free tier
npx tsx scripts/classify.ts      --seed 42 --provider rules    # offline baseline, no API
npx tsx scripts/scoreClassify.ts --seed 42                     # provider-agnostic
```

The classifier reads `match_result.json`'s residue array and nothing else. Like
the matcher, it cannot reach `labels.json` — `scripts/checkIsolation.ts` scans
`src/lib/classify/**` as well, so an import there is a build failure.
`scripts/scoreClassify.ts` is the only new script permitted to read the labels.

`ANTHROPIC_API_KEY` comes from the environment. `scripts/classify.ts` loads
`.env` via `process.loadEnvFile` if the file exists — no dependency, and anything
already exported wins. `.env` is gitignored (as is `.env.*`, with `.env.example`
explicitly re-included); `.env.example` carries a placeholder only. The key is
never written to any generated artefact.

### Two providers, one bounded component

The classifier ships with three transports behind one interface: `anthropic`,
`gemini`, and the offline `rules` baseline.

Gemini was added for a mundane reason — **cost**. The Anthropic API requires
prepaid credit, and a batch cannot run at all against a zero balance (it returns
`400 invalid_request_error: "Your credit balance is too low"`). Gemini's free
tier has no such gate, so the eval can be run and re-run by anyone cloning this
repo without a billing relationship.

The interesting part is what the swap cost. Adding a second vendor required
**zero changes to the matching engine, the confidence gate, the retry and
repair logic, the scoring script, or the taxonomy**. The only new code is a
transport implementation and the config/CLI wiring to select it:

| layer | changed for Gemini? |
| --- | --- |
| matcher (`src/lib/match/**`) | no |
| prompt text (`prompt.ts`) | no — both providers send the identical system prompt and case brief |
| output contract (`schema.ts`) | no — one Zod definition, both providers' schemas derived from it |
| orchestration, retries, confidence gate (`run.ts`) | no |
| scoring (`scoreClassify.ts`) | no — it reads `classifications.jsonl` and never asks who wrote it |
| transport | **new file**, `geminiProvider.ts` |
| shared backoff | extracted from `provider.ts` so both transports share one copy |

That is a stronger claim than picking a vendor: the LLM layer is genuinely
swappable because it was built as a bounded, well-typed component with an
explicit contract at both edges — a prompt in, a Zod-validated object out —
rather than as logic braided through the orchestration. `classifications.jsonl`
records which provider and model produced each row, so runs can be compared
directly and a partially complete batch resumes regardless of which transport
started it.

**Provider selection precedence** (documented in `config.ts`): the `--provider`
flag beats the `PROVIDER` environment variable, which beats the default
(`anthropic`). `claude` is accepted as an alias for `anthropic`. Model ids follow
the same pattern per vendor: `--model` beats `ANTHROPIC_MODEL` / `GEMINI_MODEL`
beats the built-in default. Missing API keys throw at startup, not on the first
call, so a batch never dies forty entries in.

**Gemini-specific transport notes.**

- *Structured output* uses the native `responseSchema` in `generationConfig`, not
  a JSON-and-hope instruction. Gemini's dialect is an OpenAPI 3.0 Schema subset
  rather than JSON Schema, so `toGeminiSchema()` in `geminiProvider.ts` adapts
  what `z.toJSONSchema()` emits: it flattens Zod's `anyOf: [X, {type: "null"}]`
  nullability into `X` + `nullable: true`, strips `$schema`, `minLength`,
  `minimum`/`maximum` and `additionalProperties`, and adds Gemini's
  `propertyOrdering`. Nothing is lost — `responseSchema` only guides generation,
  while the Zod schema in `run.ts` remains the enforcement layer and still
  triggers the one-shot repair retry on any violation.
- *Rate limiting* is normalised inside the provider, not by changing `run.ts`:
  Gemini's `429 RESOURCE_EXHAUSTED` and `5xx UNAVAILABLE` are mapped onto the
  same `RetrySignal` the Anthropic transport emits, including the `retryDelay`
  Google returns in `RetryInfo`. Because the free tier's per-minute cap is far
  tighter than Anthropic's, the provider also **paces itself** — a minimum
  interval between calls (default 6500ms) so a batch does not walk into a 429
  storm. Backoff remains the safety net, not the primary mechanism.
- *System prompt* goes in Gemini's dedicated `systemInstruction` field rather
  than as a leading message. That is transport plumbing only; the prompt text
  is the same string `prompt.ts` hands every provider.
- *Model default* is `gemini-3.6-flash`. `gemini-2.5-flash` was intended, but the
  API now rejects it for new keys: `404 NOT_FOUND — "no longer available to new
  users ... use models/gemini-3.6-flash"`. In practice the eval runs on
  `gemini-3.1-flash-lite` (`--model gemini-3.1-flash-lite`), because the free
  tier caps `gemini-3.6-flash` at **20 requests per day**
  (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`) and a 43-entry batch
  cannot finish under it. Quotas are per model, so a lite model has its own
  budget; it also ran ~4x faster with zero rate-limit retries.
- *Ordering.* `--order ambiguous` ranks cases by how much the finding-to-cause
  mapping is in doubt — bundled findings first, then T+3 boundary delays, then
  orphan lines — so a run cut short by a quota spends its budget on the cases
  that actually test the classifier. The rank is derived from finding codes and
  matcher evidence only; it never reads labels.
- *Thinking* is left at the model's own default. Disabling it for parity with the
  Anthropic path was the intent, but `gemini-3.6-flash` rejects
  `thinkingBudget: 0` with `400 INVALID_ARGUMENT`, so the field is omitted unless
  `GEMINI_THINKING_BUDGET` is set. Because thinking draws from the same budget as
  the answer, `maxOutputTokens` is raised to 8192 on this path; a 1024 cap can be
  consumed entirely by reasoning and return an empty candidate.

### Model call

- **Structured output is forced with tool use**, not a JSON-only system
  instruction. The input schema is enforced by the API, `tool_choice` makes
  emitting the tool mandatory, and the arguments arrive as a parsed object. A
  JSON-only instruction leaves the model free to prepend prose or wrap the
  object in a code fence, which then has to be stripped heuristically — exactly
  the silent failure this layer exists to remove.
- **One call per residue entry.** No batching: cross-contamination between cases
  is a real failure mode, and per-entry calls make retries and confidence
  cleanly attributable.
- **Temperature 0**, so eval numbers mean something across runs.
- The Zod schema in `schema.ts` is the single source of truth; the tool's JSON
  Schema is generated from it with `z.toJSONSchema()`, so the two cannot drift.

### The prompt teaches causes, not a lookup table

The matcher's finding codes do not map 1:1 to causes, and that ambiguity is the
whole reason this layer exists. `SETTLEMENT_DELAY` is a genuinely late payout or
harmless midnight noise; `ORPHAN_SETTLEMENT_LINE` is a prior-cycle refund or a
chargeback. So the system prompt describes each of the nine causes by what
physically happened, then gives an explicit criterion for every pair of causes
that can produce the same finding:

| ambiguous pair | criterion |
| --- | --- |
| `LATE_SETTLEMENT` vs `INSUFFICIENT_EVIDENCE` | The matcher measures the delay from order creation, not capture. `day_delta = 3` is a normal T+2 whose capture crossed midnight; only `>= 4` is genuinely late. |
| `REFUND_NETTED` vs `CHARGEBACK_DEBIT` | Both are orphaned debits. A `refund` line has a payment_id and order_id that are simply not in this dataset; an `adjustment` line has neither, because there was never a transaction behind it. |
| `PARTIAL_CAPTURE` vs `FEE_VARIANCE` | Partial capture is a gap between order and captured gross, usually tens of percent. Fee variance leaves gross untouched and moves only fee and tax, by well under one percent. |
| `SILENT_UPI_FAIL` vs `DUPLICATE_WEBHOOK` | Silent fail: order still `pending` while money DID settle. Duplicate: order says `paid` while no money settled for that row. |
| `UNEXPLAINED` vs `REFUND_NETTED` | Direction and source. A credit in the BANK with no settlement, versus a debit in the SETTLEMENT report with no payment. |
| `DUPLICATE_WEBHOOK` vs `INSUFFICIENT_EVIDENCE` | A duplicate needs a twin — same amount within 90s. A paid order that simply never settled supports none of the nine. |
| `ON_HOLD` vs any line-level cause | A held batch withholds every line in it, so it explains far more value than one disputed line. Name `ON_HOLD`. |

### INSUFFICIENT_EVIDENCE is rewarded, not merely permitted

The system prompt states plainly that a confident wrong cause is far more
expensive than an honest "I cannot tell", because a high-confidence answer can be
auto-approved and **booked without a human reading it** — and that the matcher is
not always right either, so saying "this case is normal" is one of the most
useful things the model can do. Guessing well is worth nothing here.

### The confidence gate

`CONFIDENCE_THRESHOLD = 0.7`, in `config.ts` and nowhere else, so it can be swept.
Below it, `requires_human_review` is forced true regardless of the predicted
cause: a low-confidence label is not a proposal, it is a "look at this" flag. The
gate also fires on `INSUFFICIENT_EVIDENCE` at any confidence. The record notes
whether the gate overrode the model (`gate_forced_review`).

### Robustness

| behaviour | how it is handled |
| --- | --- |
| schema violation | reject, retry **once** with the validation error fed back; on a second failure fall through to a human-review record. The batch never crashes. |
| transport failure | caught per entry, recorded as `transport_failure`, batch continues. |
| 429 / 5xx | exponential backoff honouring `retry-after`, up to 6 attempts. |
| crash mid-run | results are appended to `classifications.jsonl` one line at a time as each call returns. |
| rerun | entries already in the file are skipped, not re-called — **except** `transport_failure` rows, where the model never actually saw the case. A run interrupted by an outage or a billing block would otherwise leave permanent holes that a rerun silently skips. `--retry-failed` also redoes schema failures. |
| half-written line from a crash | tolerated on read, and the file is compacted before appending so the artefact never stays corrupt. |
| model echoes the wrong `residue_id` | the case id is authoritative for joining. |

### Two structural facts the score depends on

**The ceiling is 37/40, not 40/40.** Three residue entries each bundle two real
defects: a `DUPLICATE_WEBHOOK` pair whose settled twin sits inside an `ON_HOLD`
batch. One prediction per entry cannot name both causes, so three defects are
unreachable by construction. `scoreClassify.ts` prints this ceiling rather than
letting the headline look like a model failure.

**Six residue entries carry no defect at all** — the matcher's T+3 boundary
false positives. What the classifier does with those is scored separately,
because "does it know when the matcher was wrong to flag this" is a different
question from "can it name a real defect".

### Scoring

`scoreClassify.ts` leads with the one-line headline, then the two numbers that
matter — the accuracy split across the confidence gate, and the rupee value at
risk in wrong auto-approvals — **before** the per-class table and the confusion
matrix, so the important lines are not buried.

Every wrong auto-approval is itemised with its proposed action and amount. That
list is not a defect to hide: it is the exact money the human review step exists
to catch, and therefore the cost of removing that step.

### Measured: Gemini vs the rules baseline, seed 42

Both runs are complete (43/43 entries), scored by the same provider-agnostic
`scoreClassify.ts`.

| | rules baseline | gemini-3.1-flash-lite |
| --- | --- | --- |
| defects correctly classified | 37/40 (the ceiling) | 37/40 (the ceiling) |
| matcher false positives declined | 6/6 | 6/6 |
| auto-approved entries | 37 | 27 |
| sent to human review | 0 | 16 |
| auto-approved accuracy | 92.5% | 93.1% |
| human-review accuracy | n/a | 90.9% |
| value proposed for booking with no human | Rs 2,21,709.87 | Rs 40,741.13 |
| wrong auto-approvals | 0 | 0 |
| value at risk in wrong auto-approvals | Rs 0.00 | Rs 0.00 |

Both hit the same headline, which is the point: on unambiguous cases a lookup
table is already correct, so the model earns its place elsewhere. Three findings
from the comparison are worth more than the headline.

**The model routes 16 cases to a human; the lookup table routes none.** The
baseline auto-approves everything and would put Rs 2,21,709.87 in front of no
one. Gemini cuts that exposure by 82%, to Rs 40,741.13, at no cost in accuracy.

**The confidence gate never fired.** Zero of the 16 review flags came from the
0.7 threshold — Gemini's confidence never dropped below 0.9 on any of the 43
cases, including the six where the correct answer is "this is not a defect at
all". Every routing decision was the model setting `requires_human_review`
itself. The gate is therefore inert against this model, and the honest reading is
that it is a backstop for a *differently* calibrated model rather than the
mechanism doing the work here. A threshold sweep on this data would change
nothing until it passed 0.9.

**What the model actually routes on is money, not doubt.** Reviewed cases are
the ones whose proposed entry moves money it cannot verify — `PARTIAL_CAPTURE`
shortfalls, `UNEXPLAINED` bank credits, `SILENT_UPI_FAIL` corrections. Cases
whose action is "no action — timing only" are auto-approved. That is a defensible
policy and the system prompt does ask for it, but it is not the confidence-based
gate the design assumed.

**The structural blind spot passes through at maximum confidence.** Of the three
residue entries bundling two real defects, two were auto-approved as `ON_HOLD`
with `confidence: 1.0`. That is the correct dominant cause, and the scorer counts
them correct — but the `DUPLICATE_WEBHOOK` bundled inside each is silently
dropped, with nothing anywhere in the output indicating a second defect was
present. `Rs 0.00 at risk` is true under an entry-level definition of "wrong" and
still understates this. The fix is not a better prompt; it is letting a case
carry more than one cause.

## Exception review UI

```bash
npm run dev        # then open http://localhost:3000
```

The reviewer's tool: one page, three panels, no navigation between cases so
switching is instant. It reads `match_result.json` and `classifications.jsonl`
at request time and computes no matching and no scoring of its own — every
figure it shows is either read straight off disk or a sum of values already
there. The auto-approved total it prints is the same `Rs 40,741.13` that
`scoreClassify.ts` reports, because both read the same field.

`classifications.jsonl` is hardcoded, never globbed: the other jsonl files beside
it are alternate-provider runs and must not be picked up by accident.

**It cannot see the answer key.** `src/lib/ui/review.ts` and the route handler
are both scanned entry points in `scripts/checkIsolation.ts`, so an import of the
labels loader anywhere in the UI's graph fails the build — the same rule the
matcher and classifier live under.

### Layout

- **Queue** — every case, sorted the way the work actually arrives: in-review
  first, then auto-approved, biggest proposed amount first inside each group.
  Status pill, confidence as a number *and* a bar, filter toggles. A 3px gutter
  rule carries state, so the queue is readable before any text is.
- **Detail** — the matcher's evidence as a **ledger**, not cards: label left,
  figure hard-aligned right in tabular figures, hairline rules between. Then the
  entities involved, then anything the matcher considered and **ruled out**
  (dashed borders, so a reviewer never mistakes a near-miss for the match), then
  the model's verdict with its reasoning verbatim.
- **Why it is here** — the banner distinguishes *"Model flagged for review"*
  (`requires_human_review` true while confidence is at or above the gate) from
  *"Below confidence threshold"*. That is not cosmetic: on this dataset every one
  of the 16 review flags is the model's own judgment and the 0.7 gate never
  fired, so collapsing the two would hide the finding.
- **Decision bar** — Approve / Reject / Reclassify, shown only while a case is
  undecided. A rejection requires a reason; nothing else is mandatory.

### Audit log

Append-only JSONL at `data/<seed>/audit_log.jsonl` — chosen over Supabase because
it ships faster and needs no schema, no auth, and no second service for a tool
whose whole state is one growing list. Every action appends one line and nothing
is ever rewritten: deciding the same case twice leaves both lines, in order. The
route re-reads the case server-side before writing, so the log records what the
model actually said rather than what a browser claimed. The expandable panel
under the queue shows the trail read-only, so the reviewer does not have to take
it on faith. The file is gitignored — it is reviewer state, not a build artefact.

### Design

*Industrial utilitarian.* IBM Plex Sans for labels, IBM Plex Mono for every
identifier and every amount, self-hosted through `next/font` so a live demo never
waits on a font CDN. One warm neutral system; colour appears only in the three
status pills and the confidence bar. No shadows, no radii above 3px, hairline
rules instead of cards. Density is deliberate: generous space *between* cases,
tight *within* one, so a reviewer working a queue all day is reading rows rather
than hunting them.

### The case to demo

`res_bf9684ba` — a batch on hold that also bundles a duplicated order row. The
evidence ledger shows `Orders in group: 2`, `Settled orders: 1`,
`Unsettled orders: 1`, `Duplicate of: order_vxwogaznlaexkb`. The model returned
`ON_HOLD` at `confidence: 1.00` and auto-approved it. Every fact needed to name
the second defect is on screen, and nothing in the UI says a second defect
exists — which is the blind spot `scoreClassify.ts` measures as the 37/40
ceiling, made visible.
