/**
 * The model's output contract, in one place.
 *
 * Zod is the source of truth; the tool input schema handed to the API is derived
 * from it with z.toJSONSchema(), so the two can never drift apart.
 */
import { z } from "zod";

export const CAUSES = [
  "LATE_SETTLEMENT",
  "REFUND_NETTED",
  "PARTIAL_CAPTURE",
  "FEE_VARIANCE",
  "ON_HOLD",
  "DUPLICATE_WEBHOOK",
  "SILENT_UPI_FAIL",
  "CHARGEBACK_DEBIT",
  "UNEXPLAINED",
] as const;

export type Cause = (typeof CAUSES)[number];

export const INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE";

export const PREDICTIONS = [...CAUSES, INSUFFICIENT_EVIDENCE] as const;
export type Prediction = (typeof PREDICTIONS)[number];

export const adjustingEntrySchema = z.object({
  action: z
    .string()
    .min(1)
    .describe(
      'What a human should do, in plain words. Examples: "no action — timing only", ' +
        '"flag for dashboard follow-up", "book fee variance adjustment of 209 paise".',
    ),
  amount_paise: z
    .number()
    .int()
    .nullable()
    .describe(
      "Integer paise the entry would move, or null when the action moves no money. " +
        "Never a rupee value, never a float.",
    ),
});

export const classificationSchema = z.object({
  residue_id: z.string().min(1).describe("Echo the case id back unchanged."),
  predicted_cause: z
    .enum(PREDICTIONS)
    .describe(
      "The single causal class that best explains this case, or INSUFFICIENT_EVIDENCE.",
    ),
  confidence: z.number().min(0).max(1).describe("0-1. Be honest; under-confidence is cheap."),
  reasoning: z
    .string()
    .min(1)
    .describe(
      "1-3 sentences. Cite the specific evidence values you used, by name and number.",
    ),
  proposed_adjusting_entry: adjustingEntrySchema
    .nullable()
    .describe("null when no entry is proposable."),
  requires_human_review: z
    .boolean()
    .describe(
      "true when confidence is low or the evidence does not support any single cause.",
    ),
});

export type Classification = z.infer<typeof classificationSchema>;

export const CLASSIFY_TOOL_NAME = "record_classification";

/**
 * Derived from the Zod schema so there is exactly one definition of the
 * contract. `io: "input"` keeps optional/nullable handling aligned with what the
 * model is asked to produce.
 */
export function classificationJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(classificationSchema, { io: "input", target: "draft-7" }) as Record<
    string,
    unknown
  >;
}

export interface ValidationOutcome {
  ok: boolean;
  value?: Classification;
  error?: string;
}

export function validateClassification(input: unknown): ValidationOutcome {
  const parsed = classificationSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, error: issues };
}
