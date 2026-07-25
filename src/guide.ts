export const MCP_GUIDE = {
  preferredTools: {
    generalAccountState: "jpdcl_snapshot",
    supplyVoltageOutagesAndFreshness: "jpdcl_meter_health",
    importExportAndPeriodUsage: "jpdcl_energy_ledger",
    provisionalCharges: "jpdcl_tariff_estimate",
    officialBillsAndPayments: "jpdcl_account_digest",
    tariffRatesAndSource: "jpdcl_tariff_schedule",
    uncommonPortalField: "jpdcl_catalog then jpdcl_read",
  },
  sourceAuthority: [
    "WSS is authoritative for profile, sanctioned load, issued bills, billed units, payments, arrears, and account status.",
    "Genus supplies recent meter readings, voltage profiles, half-hour usage, power events, alerts, and meter metadata.",
    "The daily ledger supplies cumulative import/export/net-import kWh and kVAh; usage is derived only by register subtraction.",
    "The tariff engine is a deterministic calculation from the encoded official order, never a utility-issued bill.",
  ],
  tariffPolicy: {
    automaticUsage: "Prefer net-import register difference for a net meter; otherwise use import-register difference, with Genus current-month usage as fallback.",
    provisionalBecause: ["billing cutoffs", "export-credit settlement", "carry-forward balances", "duty", "adjustments", "later tariff revisions"],
    actualBillAuthority: "WSS billing records",
  },
  liveDataPolicy: "No consumer endpoint exposes a continuous stream or explicit communications-network online flag. Report each source timestamp and status separately.",
  defaultExclusions: ["forecasts", "recommendations", "energy-saving advice", "smart tips"],
  safety: "Consumer IDs, account IDs, meter numbers, readings, and bills are private. Mutations require explicit intent and JPDCL_ENABLE_MUTATIONS=true.",
} as const;
