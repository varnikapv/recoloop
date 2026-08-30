/**
 * Gemini transport.
 *
 * Implements the same Provider interface as the Anthropic and rules providers:
 * same input (system + per-case user prompt from prompt.ts), same output (the
 * raw structured object, left unvalidated for run.ts's Zod layer), same error
 * surface (throw, and let run.ts record a transport failure and route the case
 * to human review). No retry, gating, or scoring logic lives here — backoff is
 * the shared helper in provider.ts, and only the error-shape mapping is
 * Gemini-specific.
 */
import { ApiError, GoogleGenAI } from "@google/genai";

import {
  RESPONSE_SEED,
  TEMPERATURE,
  resolveGeminiMaxTokens,
  resolveGeminiThinkingBudget,
} from "./config";
import type { ClassifyCall, Provider, RetryInfo, RetrySignal } from "./provider";
import { sleep, withTransportRetries } from "./provider";
import { classificationJsonSchema } from "./schema";

/**
 * Adapts the JSON Schema that z.toJSONSchema() emits (draft-07, used verbatim
 * for the Anthropic tool) into Gemini's responseSchema dialect, which is an
 * OpenAPI 3.0 Schema subset rather than JSON Schema. One Zod definition remains
 * the single source of truth; this is the only place the two dialects diverge.
 *
 * Flattened:
 *   anyOf: [X, {type: "null"}]  ->  X with nullable: true
 *       Zod expresses .nullable() as a union with a null branch. Gemini has no
 *       null type and no oneOf/anyOf-with-discriminator handling for this
 *       pattern; nullability is the `nullable` boolean instead. This is the
 *       only structural rewrite, and it fires twice here:
 *       proposed_adjusting_entry and amount_paise.
 *
 * Stripped (unsupported keywords — Gemini rejects or ignores them):
 *   $schema              dialect marker; not part of the OpenAPI subset
 *   minLength            string constraints are not in the subset
 *   minimum / maximum    Zod emits +/-2^53 bounds on .int() that exceed int64
 *                        hinting and carry no useful signal; dropped uniformly
 *                        rather than kept for some fields and not others
 *   additionalProperties not supported (Zod does not emit it here, stripped
 *                        defensively in case the schema grows)
 *
 * Added:
 *   propertyOrdering     Gemini-specific; pins field order so responses are
 *                        stable across calls
 *
 * Nothing is lost by stripping. responseSchema only guides generation — the
 * Zod schema in run.ts is the enforcement layer, and it still rejects any
 * response that violates a stripped constraint, which triggers the existing
 * one-shot repair retry.
 */
const SUPPORTED_KEYWORDS = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "items",
  "properties",
  "required",
  "propertyOrdering",
  "anyOf",
]);

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNullBranch = (value: unknown): boolean =>
  isObject(value) && value["type"] === "null" && Object.keys(value).length === 1;

export function toGeminiSchema(schema: unknown): unknown {
  if (!isObject(schema)) return schema;

  let node: JsonObject = { ...schema };
  let nullable = false;

  // anyOf: [X, {type:"null"}] -> X + nullable
  const anyOf = node["anyOf"];
  if (Array.isArray(anyOf)) {
    const branches = anyOf.filter((branch) => !isNullBranch(branch));
    if (branches.length !== anyOf.length) nullable = true;
    if (branches.length === 1 && isObject(branches[0])) {
      const description = node["description"];
      node = { ...branches[0] };
      if (description !== undefined && node["description"] === undefined) {
        node["description"] = description;
      }
    } else {
      node["anyOf"] = branches.map(toGeminiSchema);
    }
  }

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (!SUPPORTED_KEYWORDS.has(key)) continue;
    if (key === "properties" && isObject(value)) {
      const properties: JsonObject = {};
      for (const [name, child] of Object.entries(value)) {
        properties[name] = toGeminiSchema(child);
      }
      out["properties"] = properties;
      out["propertyOrdering"] = Object.keys(value);
      continue;
    }
    if (key === "items") {
      out["items"] = toGeminiSchema(value);
      continue;
    }
    if (key === "anyOf" && Array.isArray(value)) {
      out["anyOf"] = value.map(toGeminiSchema);
      continue;
    }
    out[key] = value;
  }
  if (nullable) out["nullable"] = true;
  return out;
}

export function geminiResponseSchema(): unknown {
  return toGeminiSchema(classificationJsonSchema());
}

/**
 * Gemini signals rate limiting with 429 RESOURCE_EXHAUSTED and transient
 * failures with 500/503 UNAVAILABLE. Normalised onto the same RetrySignal the
 * Anthropic transport produces, so the shared backoff needs no knowledge of
 * either vendor.
 */
const RETRY_DELAY_RE = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/;

export function classifyGeminiError(error: unknown): RetrySignal {
  const message = error instanceof Error ? error.message : String(error);
  const delayMatch = RETRY_DELAY_RE.exec(message);
  const retryAfterMs =
    delayMatch === null ? undefined : Math.round(Number(delayMatch[1]) * 1000);

  let status = 0;
  if (error instanceof ApiError) {
    status = error.status;
  } else {
    // The SDK does not always wrap transport errors in ApiError; fall back to
    // the status embedded in the error text rather than silently not retrying.
    const codeMatch = /"code"\s*:\s*(\d{3})|\b(429|500|502|503|504)\b/.exec(message);
    status = Number(codeMatch?.[1] ?? codeMatch?.[2] ?? 0);
  }

  const retry = status === 429 || status === 408 || status >= 500;
  const signal: RetrySignal = { retry, status };
  if (retryAfterMs !== undefined) signal.retryAfterMs = retryAfterMs;
  return signal;
}

export interface GeminiProviderOptions {
  model: string;
  apiKey: string;
  /**
   * Minimum spacing between calls. Gemini's free tier caps requests per minute
   * far more tightly than Anthropic's paid tier, so the provider paces itself
   * rather than relying on backoff to absorb a 429 storm mid-batch.
   */
  minIntervalMs: number;
  /** Override the API host — used to exercise the retry path against a stub. */
  baseUrl?: string;
  onRetry?: (info: RetryInfo) => void;
  onPace?: (waitMs: number) => void;
}

export function createGeminiProvider(options: GeminiProviderOptions): Provider {
  if (options.apiKey === "") throw new Error("createGeminiProvider: apiKey is empty");

  const client = new GoogleGenAI({
    apiKey: options.apiKey,
    ...(options.baseUrl === undefined ? {} : { httpOptions: { baseUrl: options.baseUrl } }),
  });
  const responseSchema = geminiResponseSchema();
  // Resolved once at construction, after .env has been loaded by the CLI.
  const thinkingBudget = resolveGeminiThinkingBudget();
  const maxOutputTokens = resolveGeminiMaxTokens();
  let nextCallAt = 0;

  return {
    name: "gemini",
    model: options.model,
    async classify(call: ClassifyCall): Promise<unknown> {
      const waitMs = nextCallAt - Date.now();
      if (waitMs > 0) {
        options.onPace?.(waitMs);
        await sleep(waitMs);
      }
      nextCallAt = Date.now() + options.minIntervalMs;

      return withTransportRetries(
        async () => {
          const response = await client.models.generateContent({
            model: options.model,
            contents: [{ role: "user", parts: [{ text: call.user }] }],
            config: {
              // Gemini takes the system prompt in its own field rather than as
              // a leading message. Transport plumbing only — the prompt text is
              // the same string prompt.ts hands every provider.
              systemInstruction: call.system,
              temperature: TEMPERATURE,
              maxOutputTokens,
              seed: RESPONSE_SEED,
              responseMimeType: "application/json",
              responseSchema: responseSchema as never,
              // Omitted entirely unless explicitly configured: this model
              // rejects thinkingBudget: 0.
              ...(thinkingBudget === null ? {} : { thinkingConfig: { thinkingBudget } }),
            },
          });

          const text = response.text;
          if (text === undefined || text.trim() === "") {
            const finish = response.candidates?.[0]?.finishReason ?? "unknown";
            const blocked = response.promptFeedback?.blockReason;
            throw new Error(
              `Gemini returned no content (finishReason=${finish}` +
                (blocked === undefined ? "" : `, blockReason=${blocked}`) +
                ")",
            );
          }
          try {
            return JSON.parse(text) as unknown;
          } catch {
            // Malformed JSON is a schema problem, not a transport one: hand the
            // raw text back so Zod rejects it and run.ts's repair retry fires.
            return text;
          }
        },
        classifyGeminiError,
        options.onRetry,
      );
    },
  };
}
