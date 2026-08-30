/**
 * Model transport.
 *
 * Structured output is forced with TOOL USE rather than a JSON-only system
 * instruction. Tool use is the more reliable of the two: the input schema is
 * enforced by the API, `tool_choice` makes emitting the tool mandatory, and the
 * arguments come back as a parsed object rather than as prose that has to be
 * fished out of a code fence. A JSON-only instruction still leaves the model
 * free to prepend an apology or wrap the object in markdown, which then has to
 * be stripped heuristically — exactly the sort of silent failure this layer is
 * supposed to eliminate.
 */
import Anthropic from "@anthropic-ai/sdk";

import {
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_TOKENS,
  MAX_TRANSPORT_ATTEMPTS,
  TEMPERATURE,
} from "./config";
import { CLASSIFY_TOOL_NAME, classificationJsonSchema } from "./schema";

export interface ClassifyCall {
  system: string;
  user: string;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  /** Returns the raw tool input, unvalidated. */
  classify(call: ClassifyCall): Promise<unknown>;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Normalised retry decision. Each provider maps its own error shape onto this. */
export interface RetrySignal {
  retry: boolean;
  /** HTTP status, or 0 when the failure was below HTTP (connection reset). */
  status: number;
  /** Server-advertised wait, in ms, when it gave one. */
  retryAfterMs?: number;
}

export type RetryClassifier = (error: unknown) => RetrySignal;

export interface RetryInfo {
  attempt: number;
  status: number;
  waitMs: number;
}

function backoffMs(attempt: number, retryAfterMs: number | undefined): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) return Math.min(retryAfterMs, MAX_BACKOFF_MS);
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

/**
 * Exponential backoff, shared by every transport so there is exactly one copy of
 * this logic. A provider supplies only the mapping from its own error type to a
 * RetrySignal; the schedule itself is identical everywhere.
 *
 * Non-retryable errors are rethrown immediately — run.ts records them as a
 * transport failure and sends the case to human review.
 */
export async function withTransportRetries<T>(
  operation: () => Promise<T>,
  classify: RetryClassifier,
  onRetry?: (info: RetryInfo) => void,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_TRANSPORT_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const signal = classify(error);
      if (!signal.retry || attempt === MAX_TRANSPORT_ATTEMPTS - 1) throw error;
      const waitMs = backoffMs(attempt, signal.retryAfterMs);
      onRetry?.({ attempt: attempt + 1, status: signal.status, waitMs });
      await sleep(waitMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function classifyAnthropicError(error: unknown): RetrySignal {
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    const headers = error.headers as unknown;
    const retryAfter =
      headers instanceof Headers ? (headers.get("retry-after") ?? undefined) : undefined;
    const seconds = retryAfter === undefined ? Number.NaN : Number(retryAfter);
    const signal: RetrySignal = {
      retry: status === 429 || status === 408 || status >= 500,
      status,
    };
    if (Number.isFinite(seconds) && seconds > 0) signal.retryAfterMs = seconds * 1000;
    return signal;
  }
  if (error instanceof Anthropic.APIConnectionError) return { retry: true, status: 0 };
  return { retry: false, status: 0 };
}

export interface AnthropicProviderOptions {
  model: string;
  apiKey: string;
  /** Override the API host — used to exercise the retry path against a stub. */
  baseURL?: string;
  onRetry?: (info: RetryInfo) => void;
}

export function createAnthropicProvider(options: AnthropicProviderOptions): Provider {
  // maxRetries 0: backoff is handled here so it is explicit and observable.
  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: 0,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
  });
  const tool = {
    name: CLASSIFY_TOOL_NAME,
    description:
      "Record the classification of exactly one unreconciled case. Call this once.",
    input_schema: classificationJsonSchema() as Anthropic.Tool["input_schema"],
  };

  return {
    name: "anthropic",
    model: options.model,
    classify(call: ClassifyCall): Promise<unknown> {
      return withTransportRetries(
        async () => {
          const response = await client.messages.create({
            model: options.model,
            max_tokens: MAX_TOKENS,
            temperature: TEMPERATURE,
            system: call.system,
            tools: [tool],
            tool_choice: { type: "tool", name: CLASSIFY_TOOL_NAME },
            messages: [{ role: "user", content: call.user }],
          });
          const block = response.content.find((item) => item.type === "tool_use");
          if (block === undefined || block.type !== "tool_use") {
            throw new Error(
              `model returned no ${CLASSIFY_TOOL_NAME} tool call (stop_reason=${response.stop_reason})`,
            );
          }
          return block.input;
        },
        classifyAnthropicError,
        options.onRetry,
      );
    },
  };
}
