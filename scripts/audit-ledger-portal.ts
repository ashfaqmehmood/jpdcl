import { JpdclRuntime } from "../src/runtime.js";

const runtime = await JpdclRuntime.create();
const ledger = await runtime.energyLedger(undefined, { limit: 1 });
const consumer = ledger.consumer as { smartMeterNumber?: string | null; netMeter?: boolean | null };
const availability = ledger.availability as { sourceRecordCount?: number; latestObservation?: string | null };
const readings = ledger.readings as Array<{ cumulative?: Record<string, unknown> }>;
const requiredRegisters = ["importKwh", "exportKwh", "netImportKwh", "importKvah", "exportKvah", "netImportKvah"];
const missing = requiredRegisters.filter((key) => !(key in (readings[0]?.cumulative ?? {})));
if (!availability.sourceRecordCount || !readings.length || missing.length) {
  throw new Error(`Daily ledger audit failed; missing registers: ${missing.join(", ") || "reading rows"}`);
}
if (!consumer.smartMeterNumber) throw new Error("Daily ledger audit failed; meter number is missing");
const alarms = await runtime.ledger.alarms(consumer.smartMeterNumber);

process.stdout.write(`${JSON.stringify({
  status: "ok",
  sourceRecordCount: availability.sourceRecordCount,
  latestObservation: availability.latestObservation,
  netMeter: consumer.netMeter,
  registers: requiredRegisters,
  alarmResponseParsed: typeof alarms.hasAlarms === "boolean",
}, null, 2)}\n`);
