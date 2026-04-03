import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const SPESA_DIR = join(homedir(), ".spesa");
const LISTS_PATH = join(SPESA_DIR, "lists.json");

export interface ListItem {
  query: string;
  qty: number;
  pick?: "first" | "cheapest" | "exact";
}

export interface NamedList {
  name: string;
  items: ListItem[];
  createdAt: string;
  updatedAt: string;
}

interface ListsData {
  lists: Record<string, NamedList>;
}

function ensureDir() {
  if (!existsSync(SPESA_DIR)) mkdirSync(SPESA_DIR, { recursive: true });
}

function loadAll(): ListsData {
  if (!existsSync(LISTS_PATH)) return { lists: {} };
  try {
    return JSON.parse(readFileSync(LISTS_PATH, "utf-8")) as ListsData;
  } catch {
    return { lists: {} };
  }
}

function saveAll(data: ListsData): void {
  ensureDir();
  writeFileSync(LISTS_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function getList(name: string): NamedList | null {
  const data = loadAll();
  return data.lists[name] ?? null;
}

export function getAllLists(): NamedList[] {
  const data = loadAll();
  return Object.values(data.lists).sort((a, b) => a.name.localeCompare(b.name));
}

export function createList(name: string): NamedList {
  const data = loadAll();
  if (data.lists[name]) throw new Error(`List "${name}" already exists`);
  const now = new Date().toISOString();
  const list: NamedList = { name, items: [], createdAt: now, updatedAt: now };
  data.lists[name] = list;
  saveAll(data);
  return list;
}

export function deleteList(name: string): void {
  const data = loadAll();
  if (!data.lists[name]) throw new Error(`List "${name}" not found`);
  delete data.lists[name];
  saveAll(data);
}

export function addToList(
  listName: string,
  query: string,
  qty: number = 1,
  pick?: "first" | "cheapest" | "exact"
): ListItem {
  const data = loadAll();
  if (!data.lists[listName]) throw new Error(`List "${listName}" not found`);
  const existing = data.lists[listName].items.find(
    (i) => i.query.toLowerCase() === query.toLowerCase()
  );
  if (existing) {
    existing.qty = qty;
    if (pick) existing.pick = pick;
  } else {
    const item: ListItem = { query, qty };
    if (pick) item.pick = pick;
    data.lists[listName].items.push(item);
  }
  data.lists[listName].updatedAt = new Date().toISOString();
  saveAll(data);
  return existing ?? data.lists[listName].items[data.lists[listName].items.length - 1];
}

export function removeFromList(listName: string, query: string): void {
  const data = loadAll();
  if (!data.lists[listName]) throw new Error(`List "${listName}" not found`);
  const idx = data.lists[listName].items.findIndex(
    (i) => i.query.toLowerCase() === query.toLowerCase()
  );
  if (idx === -1) throw new Error(`Item "${query}" not found in list "${listName}"`);
  data.lists[listName].items.splice(idx, 1);
  data.lists[listName].updatedAt = new Date().toISOString();
  saveAll(data);
}

export function ensureFavorites(): void {
  const data = loadAll();
  if (!data.lists["favorites"]) {
    const now = new Date().toISOString();
    data.lists["favorites"] = { name: "favorites", items: [], createdAt: now, updatedAt: now };
    saveAll(data);
  }
}
