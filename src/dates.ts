import { JpdclError } from "./errors.js";

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function assertDateRange(
  from?: string,
  to?: string,
  options: { requireBoth?: boolean; pairedWhenPresent?: boolean } = {},
): void {
  if (from && !isIsoDate(from)) throw new JpdclError("from must be a real date in YYYY-MM-DD format", 400);
  if (to && !isIsoDate(to)) throw new JpdclError("to must be a real date in YYYY-MM-DD format", 400);
  if (options.requireBoth && (!from || !to)) throw new JpdclError("Both from and to dates are required", 400);
  if (options.pairedWhenPresent && Boolean(from) !== Boolean(to)) throw new JpdclError("Supply both from and to dates, or neither", 400);
  if (from && to && from > to) throw new JpdclError("from must be on or before to", 400);
}
