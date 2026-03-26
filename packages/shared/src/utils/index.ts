import type { TimeRange } from "../types/index.js";

// ─── Time Range Utilities ─────────────────────────────────────────────────────

export function resolveTimeRange(range: TimeRange): { startDate: Date; endDate: Date } {
  const endDate = new Date();
  const startDate = new Date();

  const dayMap: Record<TimeRange, number> = {
    "1d": 1,
    "7d": 7,
    "14d": 14,
    "30d": 30,
    "90d": 90,
    "180d": 180,
    "365d": 365,
    "custom": 30, // fallback
  };

  startDate.setDate(startDate.getDate() - (dayMap[range] ?? 30));
  return { startDate, endDate };
}

export function formatTimeRange(range: TimeRange): string {
  const labels: Record<TimeRange, string> = {
    "1d": "Last 24 hours",
    "7d": "Last 7 days",
    "14d": "Last 14 days",
    "30d": "Last 30 days",
    "90d": "Last 90 days",
    "180d": "Last 6 months",
    "365d": "Last year",
    "custom": "Custom range",
  };
  return labels[range] ?? range;
}

// ─── Number Formatting ────────────────────────────────────────────────────────

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function formatPercent(n: number, decimals = 1): string {
  return `${n.toFixed(decimals)}%`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

// ─── SQL Utilities ────────────────────────────────────────────────────────────

export function normalizeSql(sql: string): string {
  return sql
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim()
    .toLowerCase();
}

export function extractTableNames(sql: string): string[] {
  const matches = sql.matchAll(/\bfrom\s+(\w+)|\bjoin\s+(\w+)/gi);
  const tables = new Set<string>();
  for (const match of matches) {
    const table = match[1] ?? match[2];
    if (table) tables.add(table.toLowerCase());
  }
  return Array.from(tables);
}

// ─── Validation Utilities ─────────────────────────────────────────────────────

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─── Object Utilities ─────────────────────────────────────────────────────────

export function omit<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  const result = { ...obj };
  for (const key of keys) {
    delete result[key];
  }
  return result as Omit<T, K>;
}

export function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    result[key] = obj[key];
  }
  return result;
}

// ─── Chart Utilities ──────────────────────────────────────────────────────────

export function inferChartType(columns: Array<{ name: string; type: string }>): import("../types/index.js").ChartType {
  const hasDate = columns.some((c) => c.type === "date" || /date|time|day|week|month/.test(c.name));
  const numericCount = columns.filter((c) => c.type === "number").length;

  if (columns.length === 1 && numericCount === 1) return "metric";
  if (hasDate && numericCount >= 1) return "line";
  if (numericCount >= 1 && columns.length <= 3) return "bar";
  return "table";
}
