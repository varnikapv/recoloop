/**
 * Every tunable the classifier has, in one place — these get swept during eval,
 * so they must not be scattered through the code.
 */

/**
 * Below this confidence, requires_human_review is forced true regardless of what
 * predicted_cause says.
 *
 * 0.7 because a low-confidence label is not a proposal, it is a "look at this"
 * flag. The gate exists so that the auto-approved bucket can carry a financial
 * consequence — an adjusting entry someone books without reading it — while
 * everything the model is unsure about lands in front of a human instead. Set it
 * lower and wrong entries get booked; set it higher and the human queue fills
 * with cases the model actually had right, which defeats the point of the layer.
 */
export const CONFIDENCE_THRESHOLD = 0.7;

/**
 * Model id. The task specified "claude-sonnet-4-6"; override with ANTHROPIC_MODEL
 * or --model if your account exposes a different id.
 */
export const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * gemini-2.5-flash was the intended default, but the API now rejects it for new
 * keys with 404 NOT_FOUND: "no longer available to new users ... use
 * models/gemini-3.6-flash".
 *
 * The obvious replacement, gemini-3.6-flash, is unusable here: its free tier caps
 * at 20 requests per day (429 RESOURCE_EXHAUSTED,
 * GenerateRequestsPerDayPerProjectPerModel-FreeTier), and a run is 43 calls, so
 * it cannot finish a single dataset. Backoff cannot manufacture quota. The
 * default is therefore the model the published results were actually produced
 * with, so the documented command completes on a free key. Override with
 * GEMINI_MODEL or --model.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

/**
 * Minimum spacing between Gemini calls, in ms.
 *
 * Google no longer publishes a universal rate-limit table — limits are assigned
 * per project and shown in AI Studio — and public figures for free-tier flash
 * models disagree between 10 and 15 RPM. 6500ms paces at just under the stricter
 * of the two, which is safe under either and safe for a model whose published
 * limit we cannot look up. Backoff still covers a project whose real limit is
 * lower. Override with GEMINI_MIN_INTERVAL_MS.
 */
export const DEFAULT_GEMINI_MIN_INTERVAL_MS = 6_500;

/**
 * Thinking budget. Returns null — meaning "send no thinkingConfig at all and let
 * the model use its own default" — unless GEMINI_THINKING_BUDGET is set.
 *
 * The intent was to disable thinking for parity with the Anthropic path, but
 * gemini-3.6-flash rejects thinkingBudget: 0 with 400 INVALID_ARGUMENT (thinking
 * is not optional on this model, as on 2.5-pro). Omitting the field is the only
 * portable default across models that do and do not allow disabling it.
 */
export function resolveGeminiThinkingBudget(): number | null {
  const raw = process.env["GEMINI_THINKING_BUDGET"];
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Gemini needs more headroom than Anthropic: thinking tokens are drawn from the
 * same maxOutputTokens budget, so a 1024 cap can be consumed entirely by
 * reasoning and return an empty candidate with finishReason MAX_TOKENS.
 */
export function resolveGeminiMaxTokens(): number {
  const raw = Number(process.env["GEMINI_MAX_TOKENS"] ?? Number.NaN);
  return Number.isFinite(raw) && raw > 0 ? raw : 8192;
}

/** Pinned so Gemini's sampler is reproducible alongside temperature 0. */
export const RESPONSE_SEED = 42;

export const TEMPERATURE = 0; // classification, not generation — minimise run-to-run variance
export const MAX_TOKENS = 1024;

/** One retry on schema-validation failure, then fall through to human review. */
export const MAX_VALIDATION_ATTEMPTS = 2;

/** Exponential backoff for 429 / 5xx. */
export const MAX_TRANSPORT_ATTEMPTS = 6;
export const BASE_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 60_000;

/** Small fixed pause between calls so a long run does not walk into a 429. */
export const INTER_CALL_DELAY_MS = 0;

export const PROVIDER_KINDS = ["anthropic", "gemini", "rules"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** "claude" is kept as an alias so existing commands and docs keep working. */
const PROVIDER_ALIASES: Readonly<Record<string, ProviderKind>> = {
  claude: "anthropic",
  anthropic: "anthropic",
  gemini: "gemini",
  rules: "rules",
};

/**
 * Provider selection precedence, highest first:
 *   1. the --provider CLI flag
 *   2. the PROVIDER environment variable
 *   3. DEFAULT_PROVIDER
 * The flag wins when both it and the env var are set.
 */
export const DEFAULT_PROVIDER: ProviderKind = "anthropic";

export function resolveProviderKind(flag?: string): ProviderKind {
  const raw = flag !== undefined && flag !== "" ? flag : (process.env["PROVIDER"] ?? "");
  if (raw === "") return DEFAULT_PROVIDER;
  const kind = PROVIDER_ALIASES[raw.trim().toLowerCase()];
  if (kind === undefined) {
    throw new Error(`unknown provider ${JSON.stringify(raw)} (use ${PROVIDER_KINDS.join(", ")})`);
  }
  return kind;
}

/** Same override pattern for both vendors: --model beats the env var beats the default. */
export function resolveModel(override?: string): string {
  if (override !== undefined && override !== "") return override;
  const fromEnv = process.env["ANTHROPIC_MODEL"];
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : DEFAULT_MODEL;
}

export function resolveGeminiModel(override?: string): string {
  if (override !== undefined && override !== "") return override;
  const fromEnv = process.env["GEMINI_MODEL"];
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : DEFAULT_GEMINI_MODEL;
}

export function resolveGeminiMinIntervalMs(): number {
  const raw = Number(process.env["GEMINI_MIN_INTERVAL_MS"] ?? Number.NaN);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_GEMINI_MIN_INTERVAL_MS;
}
