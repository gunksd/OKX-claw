import fs from "fs";
import path from "path";

const DATA_DIR = "data";
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const MAX_ENTRIES = 500;

export function saveHistory(history: unknown[]): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const trimmed = history.slice(-MAX_ENTRIES);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2));
  } catch (e: any) {
    console.error(`[history] save failed: ${e.message}`);
  }
}

export function loadHistory(): unknown[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, "utf-8");
      const data = JSON.parse(raw);
      if (Array.isArray(data)) return data.slice(-MAX_ENTRIES);
    }
  } catch (e: any) {
    console.error(`[history] load failed, starting fresh: ${e.message}`);
  }
  return [];
}
