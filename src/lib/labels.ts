/**
 * The ONLY module in this repo that reads labels.json.
 *
 * Nothing under src/lib/match/ or src/lib/normalize.ts may reach this file,
 * directly or transitively. scripts/checkIsolation.ts enforces that as a build
 * step, so a stray import is a build failure rather than a silent leak of the
 * answer key into the matcher.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DefectCause, DefectLabel, LabelRecordType } from "./types";

export type { DefectCause, DefectLabel, LabelRecordType };

export function loadLabels(dir: string): DefectLabel[] {
  const parsed: unknown = JSON.parse(readFileSync(join(dir, "labels.json"), "utf8"));
  if (!Array.isArray(parsed)) throw new Error("labels.json is not an array");
  return parsed as DefectLabel[];
}
