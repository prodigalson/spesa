import type { CliResult } from "./types.ts";

let jsonMode = false;

export function setJsonMode(val: boolean) {
  jsonMode = val;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

export function output<T>(result: CliResult<T>): void {
  if (jsonMode) {
    console.log(JSON.stringify(result));
    return;
  }
  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    return;
  }
  if (result.message) console.log(result.message);
}

export function ok<T>(data: T, message?: string): CliResult<T> {
  return { ok: true, data, message };
}

export function err(error: string): CliResult {
  return { ok: false, error };
}

export function printTable(
  headers: string[],
  rows: (string | number)[][]
): void {
  if (jsonMode) return;

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length))
  );

  const divider = widths.map((w) => "─".repeat(w + 2)).join("┼");
  const header = headers
    .map((h, i) => ` ${h.padEnd(widths[i])} `)
    .join("│");
  const separator = widths.map((w) => "─".repeat(w + 2)).join("┼");

  console.log(`┌${divider.replace(/┼/g, "┬")}┐`);
  console.log(`│${header}│`);
  console.log(`├${separator}┤`);
  for (const row of rows) {
    const line = row
      .map((cell, i) => ` ${String(cell ?? "").padEnd(widths[i])} `)
      .join("│");
    console.log(`│${line}│`);
  }
  console.log(`└${divider.replace(/┼/g, "┴")}┘`);
}
