import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Session } from "./types.ts";

const SPESA_DIR = join(homedir(), ".spesa");
const SESSION_DIR = join(SPESA_DIR, "sessions");

function ensureDirs() {
  if (!existsSync(SPESA_DIR)) mkdirSync(SPESA_DIR, { recursive: true });
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
}

function sessionPath(platform: string): string {
  return join(SESSION_DIR, `${platform}.json`);
}

export function saveSession(session: Session): void {
  ensureDirs();
  writeFileSync(sessionPath(session.platform), JSON.stringify(session, null, 2));
}

export function loadSession(platform: string): Session | null {
  const path = sessionPath(platform);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function clearSession(platform: string): void {
  const path = sessionPath(platform);
  if (existsSync(path)) unlinkSync(path);
}

export function hasSession(platform: string): boolean {
  return existsSync(sessionPath(platform));
}

export function sessionAge(platform: string): number | null {
  const session = loadSession(platform);
  if (!session) return null;
  const savedAt = new Date(session.savedAt).getTime();
  return (Date.now() - savedAt) / 1000 / 60 / 60; // hours
}
