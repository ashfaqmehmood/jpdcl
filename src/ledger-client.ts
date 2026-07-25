import * as cheerio from "cheerio";
import { assertDateRange } from "./dates.js";
import { JpdclError } from "./errors.js";
import type { EndpointName } from "./catalog.js";
import type { RequestOptions } from "./types.js";

export const LEDGER_PORTAL_URL = "https://smartmeter1.jpdcl.co.in/smartmeter/";
export const LEDGER_CONSUMER_ENDPOINT = new URL("assets/php/_getConsumerDetails.php", LEDGER_PORTAL_URL).toString();
export const LEDGER_ALARM_ENDPOINT = new URL("assets/php/_getAlarmDetails.php", LEDGER_PORTAL_URL).toString();

export interface LedgerReading {
  observedAt: string;
  cumulative: {
    importKwh: number;
    exportKwh: number;
    netImportKwh: number;
    importKvah: number;
    exportKvah: number;
    netImportKvah: number;
  };
}

export interface LedgerConsumerData {
  _meta: {
    dataClass: "observed";
    source: "jpdcl-daily-meter-ledger";
    sourceUrl: string;
    fetchedAt: string;
    publicConsumerLookup: true;
  };
  consumer: {
    consumerId: string;
    name: string | null;
    smartMeterNumber: string | null;
    installationDate: string | null;
    netMeter: boolean | null;
    earthLoading: boolean | null;
  };
  readings: LedgerReading[];
}

export interface LedgerPeriodOptions {
  from?: string;
  to?: string;
  limit?: number;
}

export class JpdclLedgerClient {
  private readonly cache = new Map<string, { at: number; value: LedgerConsumerData }>();

  constructor(private readonly timeoutMs = 20_000, private readonly cacheMs = 30_000) {}

  async consumer(consumerId: string): Promise<LedgerConsumerData> {
    validateConsumerId(consumerId);
    const cached = this.cache.get(consumerId);
    if (cached && Date.now() - cached.at < this.cacheMs) return cached.value;
    const response = await postForm(LEDGER_CONSUMER_ENDPOINT, { consumercode: consumerId }, this.timeoutMs);
    if (!response.ok) throw new JpdclError(`Daily meter portal returned HTTP ${response.status}`, response.status);
    const parsed = parseLedgerHtml(await response.text(), consumerId);
    this.cache.set(consumerId, { at: Date.now(), value: parsed });
    return parsed;
  }

  async alarms(meterNumber: string): Promise<Record<string, unknown>> {
    if (!meterNumber.trim()) throw new JpdclError("A smart-meter number is required", 400);
    const response = await postForm(LEDGER_ALARM_ENDPOINT, { meterSno: meterNumber.trim() }, this.timeoutMs);
    if (!response.ok) throw new JpdclError(`Daily meter alarm endpoint returned HTTP ${response.status}`, response.status);
    const body = await response.text();
    const noAlarms = /no\s+alarms/i.test(body);
    const tables = noAlarms ? [] : parseGenericTables(body);
    return {
      _meta: {
        dataClass: "observed",
        source: "jpdcl-daily-meter-ledger-alarm-endpoint",
        sourceUrl: LEDGER_ALARM_ENDPOINT,
        fetchedAt: new Date().toISOString(),
      },
      meterNumber,
      hasAlarms: noAlarms ? false : tables.some((table) => table.rows.length > 0),
      tables,
      message: noAlarms ? "No Alarms" : undefined,
    };
  }

  async request(name: EndpointName | string, options: RequestOptions = {}): Promise<unknown> {
    if (name === "ledger_consumer_readings") {
      const consumerId = String(options.params?.consumerId ?? (options.body as Record<string, unknown> | undefined)?.consumerId ?? "");
      return this.consumer(consumerId);
    }
    if (name === "ledger_meter_alarms") {
      const meterNumber = String(options.params?.meterNumber ?? (options.body as Record<string, unknown> | undefined)?.meterNumber ?? "");
      return this.alarms(meterNumber);
    }
    throw new JpdclError(`Unknown daily meter ledger endpoint: ${name}`, 400);
  }
}

export function parseLedgerHtml(html: string, expectedConsumerId: string): LedgerConsumerData {
  const [profileHtml, tableHtml = ""] = html.split("||||");
  const profile = parseProfile(profileHtml ?? "");
  const $ = cheerio.load(tableHtml);
  const readings: LedgerReading[] = [];
  $("#readtable1 tbody tr").each((_, row) => {
    const cells = $(row).find("td").map((__, cell) => $(cell).text().trim()).get();
    if (cells.length < 7 || !/^\d{4}-\d{2}-\d{2}$/.test(cells[0] ?? "")) return;
    const values = cells.slice(1, 7).map(Number);
    if (values.some((value) => !Number.isFinite(value))) return;
    readings.push({
      observedAt: `${cells[0]}T00:00:00+05:30`,
      cumulative: {
        importKwh: values[0]!, exportKwh: values[1]!, netImportKwh: values[2]!,
        importKvah: values[3]!, exportKvah: values[4]!, netImportKvah: values[5]!,
      },
    });
  });
  readings.sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  if (!readings.length) throw new JpdclError("No daily meter readings were returned for this consumer ID", 404);
  const consumerId = profile["consumer id"] || expectedConsumerId;
  return {
    _meta: {
      dataClass: "observed",
      source: "jpdcl-daily-meter-ledger",
      sourceUrl: LEDGER_CONSUMER_ENDPOINT,
      fetchedAt: new Date().toISOString(),
      publicConsumerLookup: true,
    },
    consumer: {
      consumerId,
      name: nullable(profile.name),
      smartMeterNumber: nullable(profile["smart meter"]),
      installationDate: validDate(profile["inatallation date"] ?? profile["installation date"]),
      netMeter: yesNo(profile["net meter"]),
      earthLoading: yesNo(profile["earth-loading"]),
    },
    readings,
  };
}

export function ledgerPeriod(data: LedgerConsumerData, options: LedgerPeriodOptions = {}) {
  const newestDate = data.readings[0]?.observedAt.slice(0, 10);
  if (!newestDate) throw new JpdclError("The daily meter ledger is empty", 404);
  const from = options.from ?? `${newestDate.slice(0, 7)}-01`;
  const to = options.to ?? newestDate;
  assertDateRange(from, to, { requireBoth: true });
  const ascending = [...data.readings].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const selected = ascending.filter((reading) => {
    const day = reading.observedAt.slice(0, 10);
    return day >= from && day <= to;
  });
  const baseline = [...ascending].reverse().find((reading) => reading.observedAt.slice(0, 10) < from) ?? selected[0];
  const latest = selected.at(-1);
  const deltas = new Map<string, ReturnType<typeof subtractReadings>>();
  for (let index = 1; index < ascending.length; index++) {
    deltas.set(ascending[index]!.observedAt, subtractReadings(ascending[index]!, ascending[index - 1]!));
  }
  const requestedLimit = Math.max(0, Math.floor(options.limit ?? 35));
  const returned = (requestedLimit === 0 ? [] : [...selected].reverse().slice(0, requestedLimit)).map((reading) => ({
    ...reading,
    usageSincePreviousObservation: deltas.get(reading.observedAt) ?? null,
  }));
  const periodUsage = baseline && latest ? subtractReadings(latest, baseline) : null;
  const settlementCandidateKwh = periodUsage
    ? data.consumer.netMeter ? Math.max(0, periodUsage.netImportKwh) : Math.max(0, periodUsage.importKwh)
    : null;
  const latestDay = new Date(`${newestDate}T00:00:00+05:30`).getTime();
  return {
    _meta: {
      dataClass: "observed-with-deterministic-deltas",
      source: data._meta.source,
      fetchedAt: data._meta.fetchedAt,
      calculation: "cumulative register subtraction",
    },
    consumer: data.consumer,
    availability: {
      firstObservation: data.readings.at(-1)?.observedAt ?? null,
      latestObservation: data.readings[0]?.observedAt ?? null,
      sourceRecordCount: data.readings.length,
      freshnessHoursAtFetch: Math.max(0, Math.round((new Date(data._meta.fetchedAt).getTime() - latestDay) / 360_000) / 10),
    },
    period: {
      from,
      to,
      baselineObservation: baseline?.observedAt ?? null,
      latestObservation: latest?.observedAt ?? null,
      usage: periodUsage,
      provisionalBillableKwh: settlementCandidateKwh,
      provisionalBillableBasis: data.consumer.netMeter ? "net-import-register-difference" : "import-register-difference",
      warning: "Register differences are meter evidence, but JPDCL may use different billing cutoffs, adjustments, carry-forward credits, or settlement rules.",
    },
    readings: returned,
    pagination: { returned: returned.length, matched: selected.length, limit: requestedLimit || null },
  };
}

function subtractReadings(current: LedgerReading, previous: LedgerReading) {
  const result: Record<string, number> = {};
  for (const key of Object.keys(current.cumulative) as Array<keyof LedgerReading["cumulative"]>) {
    result[key] = round3(current.cumulative[key] - previous.cumulative[key]);
  }
  return result as LedgerReading["cumulative"];
}

function parseProfile(html: string): Record<string, string> {
  const $ = cheerio.load(html);
  const profile: Record<string, string> = {};
  $(".row").each((_, row) => {
    const columns = $(row).find(".col").map((__, column) => $(column).text().replace(/\s+/g, " ").trim()).get();
    const key = columns[0]?.toLowerCase();
    if (!key) return;
    profile[key] = $(row).find("input").attr("value")?.trim() ?? columns[1] ?? "";
  });
  return profile;
}

function parseGenericTables(html: string) {
  const $ = cheerio.load(html);
  return $("table").map((_, table) => {
    const headers = $(table).find("thead th").map((__, cell) => $(cell).text().replace(/\s+/g, " ").trim()).get();
    const rows = $(table).find("tbody tr").map((__, row) => [$(row).find("td").map((___, cell) => $(cell).text().replace(/\s+/g, " ").trim()).get()]).get();
    return { headers, rows };
  }).get();
}

async function postForm(url: string, fields: Record<string, string>, timeoutMs: number): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      Accept: "text/html, */*; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function validateConsumerId(value: string): void {
  if (!/^\d{1,13}$/.test(value)) throw new JpdclError("Consumer ID must contain 1 to 13 digits", 400);
}

function nullable(value: string | undefined): string | null {
  return value?.trim() ? value.trim() : null;
}

function validDate(value: string | undefined): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) && value !== "0000-00-00" ? value : null;
}

function yesNo(value: string | undefined): boolean | null {
  if (!value) return null;
  if (/^yes$/i.test(value.trim())) return true;
  if (/^no$/i.test(value.trim())) return false;
  return null;
}

function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
