import type { CliResult, ErrorCode } from "./types.ts";

let jsonMode = false;
let plainMode = false;
let yesMode = false;

export function setJsonMode(val: boolean) {
  jsonMode = val;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

export function setPlainMode(val: boolean) {
  plainMode = val;
}

export function isPlainMode(): boolean {
  return plainMode;
}

export function setYesMode(val: boolean) {
  yesMode = val;
}

export function isYesMode(): boolean {
  return yesMode;
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

export function err(error: string, errorCode?: ErrorCode): CliResult {
  return { ok: false, error, errorCode };
}

export function printTable(
  headers: string[],
  rows: (string | number)[][]
): void {
  if (jsonMode) return;

  if (plainMode) {
    console.log(headers.join("\t"));
    for (const row of rows) {
      console.log(row.map((cell) => String(cell ?? "")).join("\t"));
    }
    return;
  }

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
