#!/usr/bin/env bun
/**
 * Version bump script.
 *
 * Usage:
 *   bun run bump                    # shows current version
 *   bun run bump 0.3.0              # set exact version
 *   bun run bump patch              # 0.2.1 → 0.2.2
 *   bun run bump minor              # 0.2.1 → 0.3.0
 *   bun run bump major              # 0.2.1 → 1.0.0
 *
 * Updates these files:
 *   - src/version.ts    (source of truth)
 *   - package.json      (npm version field)
 *   - SKILL.md          (frontmatter version field)
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

function readVersion(): string {
  const content = readFileSync(join(ROOT, "src/version.ts"), "utf-8");
  const match = content.match(/VERSION\s*=\s*"([^"]+)"/);
  if (!match) throw new Error("Could not parse version from src/version.ts");
  return match[1];
}

function bumpVersion(current: string, level: string): string {
  const [major, minor, patch] = current.split(".").map(Number);
  switch (level) {
    case "major": return `${major + 1}.0.0`;
    case "minor": return `${major}.${minor + 1}.0`;
    case "patch": return `${major}.${minor}.${patch + 1}`;
    default:
      // Assume it's an exact version string
      if (/^\d+\.\d+\.\d+$/.test(level)) return level;
      throw new Error(`Invalid version or level: "${level}". Use: patch, minor, major, or X.Y.Z`);
  }
}

function updateFile(path: string, replacer: (content: string) => string) {
  const full = join(ROOT, path);
  const content = readFileSync(full, "utf-8");
  const updated = replacer(content);
  if (content === updated) {
    console.log(`  ⚠ ${path}: no change`);
  } else {
    writeFileSync(full, updated);
    console.log(`  ✓ ${path}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

const current = readVersion();
const arg = process.argv[2];

if (!arg) {
  console.log(`Current version: ${current}`);
  console.log(`\nUsage: bun run bump <patch|minor|major|X.Y.Z>`);
  process.exit(0);
}

const next = bumpVersion(current, arg);
console.log(`Bumping: ${current} → ${next}\n`);

// 1. src/version.ts
updateFile("src/version.ts", (c) =>
  c.replace(/VERSION\s*=\s*"[^"]+"/, `VERSION = "${next}"`)
);

// 2. package.json
updateFile("package.json", (c) =>
  c.replace(/"version"\s*:\s*"[^"]+"/, `"version": "${next}"`)
);

// 3. SKILL.md frontmatter
updateFile("SKILL.md", (c) =>
  c.replace(/^(version:\s*).+$/m, `$1${next}`)
);

console.log(`\nDone. Run: git add -A && git commit -m "chore: bump to v${next}"`);
