export type ArgSpec = Readonly<Record<string, number | string | boolean>>;

/**
 * Minimal --flag value parser. Unknown flags are an error, not a shrug.
 *
 * A flag whose default is a boolean is a bare switch: `--fresh` sets it true and
 * consumes no value. `--fresh=false` still works for an explicit override.
 */
export function parseArgs<T extends ArgSpec>(argv: readonly string[], defaults: T): T {
  const out: Record<string, number | string | boolean> = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const [flag, inlineValue] = token.slice(2).split("=", 2);
    const key = flag as string;
    if (!(key in defaults)) throw new Error(`unknown flag: --${key}`);
    if (typeof defaults[key] === "boolean") {
      out[key] = inlineValue === undefined ? true : inlineValue !== "false";
      continue;
    }
    const raw = inlineValue ?? argv[++i];
    if (raw === undefined) throw new Error(`--${key} needs a value`);
    if (typeof defaults[key] === "number") {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`--${key} must be a number, got ${raw}`);
      out[key] = value;
    } else {
      out[key] = raw;
    }
  }
  return out as T;
}

/** Fixed-width table, no dependencies. */
export function renderTable(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  return [line(headers), rule, ...rows.map(line)].join("\n");
}
