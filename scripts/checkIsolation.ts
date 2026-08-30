#!/usr/bin/env tsx
/**
 * Build guard: the matcher must be structurally incapable of reading the answer
 * key. Walks the static import graph from the matcher's entry points and fails
 * if it can reach the labels loader, the defect taxonomy, or a literal mention
 * of labels.json.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const ENTRY_POINTS = [
  "src/lib/match/run.ts",
  "src/lib/normalize.ts",
  "scripts/match.ts",
  "src/lib/classify/run.ts",
  "src/lib/classify/prompt.ts",
  "src/lib/classify/rulesProvider.ts",
  "src/lib/classify/geminiProvider.ts",
  "scripts/classify.ts",
];
const FORBIDDEN_MODULES = ["src/lib/labels.ts"];
const FORBIDDEN_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["reads labels.json", /labels\.json/],
  ["imports the defect taxonomy", /\bDEFECT_CAUSES\b|\bDefectLabel\b|\bDefectCause\b/],
  ["imports true_cause", /\btrue_cause\b/],
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']/g;

/**
 * Strip comments before scanning, so a doc comment describing the rule is not
 * itself a violation. Respects string and template literals.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < source.length) {
        const inner = source[i] as string;
        out += inner;
        i++;
        if (inner === "\\") {
          out += source[i] ?? "";
          i++;
          continue;
        }
        if (inner === quote) break;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function resolveImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function main(): void {
  const visited = new Set<string>();
  const queue = ENTRY_POINTS.map((p) => resolve(ROOT, p));
  const violations: string[] = [];

  for (const entry of queue) {
    if (!existsSync(entry)) throw new Error(`entry point missing: ${entry}`);
  }

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (visited.has(file)) continue;
    visited.add(file);

    const rel = relative(ROOT, file);
    const source = readFileSync(file, "utf8");
    const code = stripComments(source);

    if (FORBIDDEN_MODULES.some((m) => rel === m)) {
      violations.push(`${rel}: labels loader is reachable from the matcher`);
    }
    for (const [why, pattern] of FORBIDDEN_PATTERNS) {
      if (pattern.test(code)) violations.push(`${rel}: ${why}`);
    }

    IMPORT_RE.lastIndex = 0;
    for (let hit = IMPORT_RE.exec(code); hit !== null; hit = IMPORT_RE.exec(code)) {
      const target = resolveImport(file, hit[1] as string);
      if (target !== null) queue.push(target);
    }
  }

  const files = [...visited].map((f) => relative(ROOT, f)).sort();
  if (violations.length > 0) {
    console.error("matcher isolation VIOLATED:");
    for (const violation of violations) console.error(`  ${violation}`);
    console.error(`\nreachable modules (${files.length}):`);
    for (const file of files) console.error(`  ${file}`);
    process.exit(1);
  }

  console.log(`matcher isolation OK — ${files.length} module(s) reachable, none can see the labels:`);
  for (const file of files) console.log(`  ${file}`);
}

try {
  main();
} catch (error) {
  console.error(`recoloop: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
