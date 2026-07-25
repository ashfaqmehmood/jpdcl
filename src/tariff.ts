export const JPDCL_TARIFF_ORDER_2025_26 = {
  id: "JPDCL-JERC-FY2025-26-SUBSIDIZED",
  title: "JPDCL & KPDCL ARR and Tariff for FY 2025-26 - Subsidized Tariff",
  fiscalYear: "2025-26",
  sourceUrl: "https://jpdcl.jk.gov.in/downloads/tariff/JPDCL_Tariff_Order_2025_26.pdf",
  domesticSchedule: {
    pdfPages: [159, 160],
    printedPages: [139, 140],
    energySlabs: [
      { upToKwh: 200, ratePerKwh: 2.30 },
      { upToKwh: 400, ratePerKwh: 4.00 },
      { upToKwh: null, ratePerKwh: 4.35 },
    ],
    fixedChargePerKwMonth: 8.00,
    loadRoundingKw: 0.5,
  },
  generalTerms: {
    pdfPages: [176, 177, 178, 179, 180],
    printedPages: [156, 157, 158, 159, 160],
    prepaidEnergyRebatePercent: 2,
    latePaymentPercentPerMonth: 1.5,
    solarWaterHeaterRebatePerMonth: 150,
  },
} as const;

export interface DomesticTariffInput {
  unitsKwh: number;
  sanctionedLoadKw: number;
  prepaid?: boolean;
  solarWaterHeaterEligible?: boolean;
  electricityDutyAmount?: number;
  otherChargesAmount?: number;
  unpaidPrincipalAmount?: number;
  lateMonths?: number;
}

export interface TariffSlabCharge {
  fromKwh: number;
  toKwh: number | null;
  unitsKwh: number;
  ratePerKwh: number;
  amount: number;
}

export function calculateDomesticMeteredCharges(input: DomesticTariffInput) {
  requireNonNegative("unitsKwh", input.unitsKwh);
  requireNonNegative("sanctionedLoadKw", input.sanctionedLoadKw);
  const billedUnitsKwh = Math.round(input.unitsKwh);
  const billedLoadKw = Math.ceil(input.sanctionedLoadKw / 0.5) * 0.5;
  const slabCharges = calculateSlabs(billedUnitsKwh);
  const energyCharge = roundMoney(slabCharges.reduce((sum, slab) => sum + slab.amount, 0));
  const fixedCharge = roundMoney(billedLoadKw * JPDCL_TARIFF_ORDER_2025_26.domesticSchedule.fixedChargePerKwMonth);
  const prepaidRebate = input.prepaid
    ? roundMoney(energyCharge * JPDCL_TARIFF_ORDER_2025_26.generalTerms.prepaidEnergyRebatePercent / 100)
    : 0;
  const solarWaterHeaterRebate = input.solarWaterHeaterEligible
    ? JPDCL_TARIFF_ORDER_2025_26.generalTerms.solarWaterHeaterRebatePerMonth
    : 0;
  const electricityDuty = optionalMoney("electricityDutyAmount", input.electricityDutyAmount);
  const otherCharges = optionalMoney("otherChargesAmount", input.otherChargesAmount);
  const lateMonths = input.lateMonths ?? 0;
  requireNonNegative("lateMonths", lateMonths);
  const unpaidPrincipal = optionalMoney("unpaidPrincipalAmount", input.unpaidPrincipalAmount);
  const latePaymentSurcharge = roundMoney(
    unpaidPrincipal * lateMonths * JPDCL_TARIFF_ORDER_2025_26.generalTerms.latePaymentPercentPerMonth / 100,
  );
  const tariffSubtotal = roundMoney(Math.max(0, energyCharge + fixedCharge - prepaidRebate - solarWaterHeaterRebate));
  const totalEstimate = roundMoney(tariffSubtotal + electricityDuty + otherCharges + latePaymentSurcharge);

  return {
    _meta: {
      dataClass: "deterministic-calculation",
      purpose: "estimate-not-utility-bill",
      tariffOrderId: JPDCL_TARIFF_ORDER_2025_26.id,
      formulaVersion: "1.0",
    },
    input: {
      measuredUnitsKwh: input.unitsKwh,
      billedUnitsKwh,
      sanctionedLoadKw: input.sanctionedLoadKw,
      billedLoadKw,
      prepaid: Boolean(input.prepaid),
      solarWaterHeaterEligible: Boolean(input.solarWaterHeaterEligible),
    },
    rates: {
      energySlabs: JPDCL_TARIFF_ORDER_2025_26.domesticSchedule.energySlabs,
      fixedChargePerKwMonth: JPDCL_TARIFF_ORDER_2025_26.domesticSchedule.fixedChargePerKwMonth,
      prepaidEnergyRebatePercent: JPDCL_TARIFF_ORDER_2025_26.generalTerms.prepaidEnergyRebatePercent,
      latePaymentPercentPerMonth: JPDCL_TARIFF_ORDER_2025_26.generalTerms.latePaymentPercentPerMonth,
      solarWaterHeaterRebatePerMonth: JPDCL_TARIFF_ORDER_2025_26.generalTerms.solarWaterHeaterRebatePerMonth,
    },
    slabCharges,
    charges: {
      energyCharge,
      fixedCharge,
      prepaidRebate: -prepaidRebate,
      solarWaterHeaterRebate: -solarWaterHeaterRebate,
      tariffSubtotal,
      electricityDuty,
      otherCharges,
      latePaymentSurcharge,
      totalEstimate,
      currency: "INR",
    },
    exclusions: [
      "arrears and bill adjustments unless supplied as otherChargesAmount",
      "electricity duty or government levy unless supplied as electricityDutyAmount",
      "FPPCA or later tariff revision not present in the cited order",
      "excess-demand charges unless assessed by JPDCL",
      "meter defects, penalties, and utility-specific rounding or adjustments",
    ],
    source: JPDCL_TARIFF_ORDER_2025_26,
  };
}

function calculateSlabs(unitsKwh: number): TariffSlabCharge[] {
  const definitions = [
    { fromKwh: 1, toKwh: 200, width: 200, ratePerKwh: 2.30 },
    { fromKwh: 201, toKwh: 400, width: 200, ratePerKwh: 4.00 },
    { fromKwh: 401, toKwh: null, width: Number.POSITIVE_INFINITY, ratePerKwh: 4.35 },
  ] as const;
  let remaining = unitsKwh;
  return definitions.map((definition) => {
    const slabUnits = Math.max(0, Math.min(remaining, definition.width));
    remaining -= slabUnits;
    return {
      fromKwh: definition.fromKwh,
      toKwh: definition.toKwh,
      unitsKwh: slabUnits,
      ratePerKwh: definition.ratePerKwh,
      amount: roundMoney(slabUnits * definition.ratePerKwh),
    };
  }).filter((slab) => slab.unitsKwh > 0);
}

function optionalMoney(name: string, value: number | undefined): number {
  if (value === undefined) return 0;
  requireNonNegative(name, value);
  return roundMoney(value);
}

function requireNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative finite number`);
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
