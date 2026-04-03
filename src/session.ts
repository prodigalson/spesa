import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Session } from "./types.ts";

const SPESA_DIR = join(homedir(), ".spesa");
const SESSION_DIR = join(SPESA_DIR, "sessions");
const CREDS_PATH = join(SPESA_DIR, "credentials.json");

export interface StoredCredentials {
  platform: string;
  username: string;
  password: string;
  savedAt: string;
}

function ensureDirs() {
  if (!existsSync(SPESA_DIR)) mkdirSync(SPESA_DIR, { recursive: true });
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
}

function sessionPath(platform: string): string {
  return join(SESSION_DIR, `${platform}.json`);
}

export function saveSession(session: Session): void {
  ensureDirs();
  writeFileSync(sessionPath(session.platform), JSON.stringify(session, null, 2), { mode: 0o600 });
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

// ─── Credential storage (for auto session refresh) ─────────────────────────

export function saveCredentials(platform: string, username: string, password: string): void {
  ensureDirs();
  const creds: StoredCredentials = {
    platform,
    username,
    password,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function loadCredentials(platform: string): StoredCredentials | null {
  if (!existsSync(CREDS_PATH)) return null;
  try {
    const raw = readFileSync(CREDS_PATH, "utf-8");
    const creds = JSON.parse(raw) as StoredCredentials;
    if (creds.platform !== platform) return null;
    return creds;
  } catch {
    return null;
  }
}

export function clearCredentials(): void {
  if (existsSync(CREDS_PATH)) unlinkSync(CREDS_PATH);
}
