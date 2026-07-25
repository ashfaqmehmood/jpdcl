import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { endpointCatalog, listEndpoints } from "./catalog.js";
import { decryptPayload, encryptPayload, ENCRYPTED_FIELD } from "./crypto.js";
import { resolveCredentials } from "./credentials.js";
import { assertDateRange, isIsoDate } from "./dates.js";
import { buildUrl } from "./http.js";
import { ledgerPeriod, parseLedgerHtml } from "./ledger-client.js";
import { decodeJwt, encodeReportFilter, SmartMeterClient, smartApiUrlFromAppUrl } from "./smart-client.js";
import { calculateDomesticMeteredCharges } from "./tariff.js";

describe("JPDCL protocol helpers", () => {
  it("round-trips the portal AES envelope", () => {
    const source = { accountid: "0000000000", nested: { enabled: true } };
    const encrypted = encryptPayload(source)[ENCRYPTED_FIELD];
    assert.equal(typeof encrypted, "string");
    assert.deepEqual(decryptPayload(encrypted!), source);
  });

  it("fills path parameters and preserves query parameters", () => {
    assert.equal(buildUrl("https://example.test/api", "/meter/{id}", { id: "A/B", from: "2026-01-01" }),
      "https://example.test/api/meter/A%2FB?from=2026-01-01");
  });

  it("derives the API root and decodes SSO claims", () => {
    const payload = Buffer.from(JSON.stringify({ currentAccountKno: "123", exp: 2_000_000_000 }), "utf8").toString("base64url");
    assert.equal(decodeJwt(`x.${payload}.y`).currentAccountKno, "123");
    assert.equal(smartApiUrlFromAppUrl("https://cp.example.test/dashboard"), "https://cp.example.test/api");
  });

  it("exchanges the SSO JWT for a consumer-scoped smart-meter token", async () => {
    const initialToken = testJwt({
      sub: "user-1",
      currentAccountUserId: "account-user-1",
      currentAccountTenantId: "tenant-1",
      currentAccountKno: "123",
      currentAccountMeterNo: "M1",
      currentAccountMobile: "0000000000",
      currentAccountName: "Test Consumer",
    });
    const switchedToken = testJwt({
      sub: "user-1",
      currentAccountUserId: "account-user-1",
      currentAccountTenantId: "tenant-1",
      currentAccountKno: "123",
      currentAccountMeterNo: "M1",
    });
    let request: { url?: string; init?: RequestInit } = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      request = { url: String(input), init };
      return new Response(JSON.stringify({
        success: true,
        data: { accessToken: switchedToken, selectedTenantId: "tenant-1" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const initial = new SmartMeterClient(initialToken, "https://smart.example.test/api", false);
      const scoped = await initial.switchAccount("123", "M1");
      assert.equal(scoped.accountScoped, true);
      assert.equal(scoped.bearerToken, switchedToken);
      assert.equal(scoped.accountId, "123");
      assert.equal(request.url, "https://smart.example.test/api/Authentication/switch-account");
      const switchHeaders = request.init?.headers as Record<string, string>;
      assert.equal(switchHeaders.Authorization, `Bearer ${initialToken}`);
      assert.equal(switchHeaders.Origin, undefined);
      assert.equal(switchHeaders.Referer, undefined);
      assert.equal(switchHeaders.TenantId, undefined);
      assert.deepEqual(JSON.parse(String(request.init?.body)), {
        tenantId: "tenant-1",
        userId: "account-user-1",
        uniqueId: "account-user-1",
        kno: "123",
        mobileNo: "0000000000",
        email: "",
        consumerName: "Test Consumer",
        isPrimaryUser: true,
        isRegistered: true,
        userTableId: 0,
        consumerId: 0,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("switches account context once and retries a smart request after HTTP 403", async () => {
    const initialToken = testJwt({
      sub: "user-1",
      currentAccountUserId: "account-user-1",
      currentAccountTenantId: "tenant-1",
      currentAccountKno: "123",
      currentAccountMeterNo: "M1",
      currentAccountMobile: "0000000000",
      currentAccountName: "Test Consumer",
    });
    const switchedToken = testJwt({
      sub: "user-1",
      currentAccountUserId: "account-user-1",
      currentAccountTenantId: "tenant-1",
      currentAccountKno: "123",
      currentAccountMeterNo: "M1",
    });
    const requestedUrls: string[] = [];
    let switchCookie: string | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === "https://smart.example.test/") {
        const response = new Response("portal", { status: 200, headers: { "set-cookie": "AWSALB=sticky-session; Path=/" } });
        Object.defineProperty(response, "url", { value: url });
        return response;
      }
      if (url.endsWith("/Authentication/switch-account")) {
        switchCookie = input instanceof Request
          ? input.headers.get("cookie")
          : new Headers(init?.headers).get("cookie");
        return new Response(JSON.stringify({ success: true, data: { accessToken: switchedToken } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (requestedUrls.filter((item) => item.includes("todayormonthlyconsumption")).length === 1) {
        return new Response("Forbidden", { status: 403, headers: { "content-type": "text/html" } });
      }
      return new Response(JSON.stringify({ success: true, data: { monthlyConsumption: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const client = new SmartMeterClient(initialToken, "https://smart.example.test/api", false, "tenant-1", undefined, true);
      const response = await client.request("smart_today_monthly", { params: { meterNumber: "M1" } });
      assert.equal(response.status, true);
      assert.equal(client.bearerToken, switchedToken);
      assert.equal(switchCookie, "AWSALB=sticky-session");
      assert.deepEqual(requestedUrls, [
        "https://smart.example.test/api/EnergyConsumption/todayormonthlyconsumption/M1",
        "https://smart.example.test/",
        "https://smart.example.test/api/Authentication/switch-account",
        "https://smart.example.test/api/EnergyConsumption/todayormonthlyconsumption/M1",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("encodes the report filter exactly as the smart portal", () => {
    const decoded = JSON.parse(Buffer.from(encodeReportFilter("2026-07-01", "2026-07-24", 1, 10), "base64").toString("utf8"));
    assert.deepEqual(decoded, { start: 1, end: 10, filters: { createdDateFrom: "2026-07-01", createdDateTo: "2026-07-24" } });
  });

  it("rejects impossible or descending date ranges before a portal call", () => {
    assert.equal(isIsoDate("2026-02-28"), true);
    assert.equal(isIsoDate("2026-02-31"), false);
    assert.throws(() => assertDateRange("2026-07-25", "2026-07-24"), /from must be on or before to/);
    assert.throws(() => assertDateRange("2026-07-24", undefined, { pairedWhenPresent: true }), /both from and to/i);
  });

  it("resolves unattended credentials from the environment without persisting them", async () => {
    const previousLogin = process.env.JPDCL_LOGIN_ID;
    const previousPassword = process.env.JPDCL_PASSWORD;
    try {
      process.env.JPDCL_LOGIN_ID = "test-login";
      process.env.JPDCL_PASSWORD = "test-password";
      assert.deepEqual(await resolveCredentials(), {
        loginId: "test-login",
        password: "test-password",
        source: "environment",
      });
    } finally {
      if (previousLogin === undefined) delete process.env.JPDCL_LOGIN_ID;
      else process.env.JPDCL_LOGIN_ID = previousLogin;
      if (previousPassword === undefined) delete process.env.JPDCL_PASSWORD;
      else process.env.JPDCL_PASSWORD = previousPassword;
    }
  });
});

describe("endpoint catalog", () => {
  it("contains broad main and smart coverage", () => {
    assert.ok(listEndpoints("main").length >= 40);
    assert.ok(listEndpoints("smart").length >= 70);
    assert.equal(listEndpoints("ledger").length, 2);
  });

  it("marks consequential actions as mutations", () => {
    assert.equal(endpointCatalog.main_initiate_payment.mutation, true);
    assert.equal(endpointCatalog.smart_on_demand_request.mutation, true);
    assert.equal(endpointCatalog.smart_update_preferences.mutation, true);
    assert.equal(endpointCatalog.smart_update_preferences.method, "PUT");
    assert.equal(endpointCatalog.smart_update_alerts.method, "POST");
    assert.notEqual(endpointCatalog.smart_switch_account.mutation, true);
    assert.notEqual(endpointCatalog.smart_today_monthly.mutation, true);
    assert.equal(endpointCatalog.smart_today_monthly.dataClass, "observed");
    assert.equal(endpointCatalog.smart_forecast_monthly.dataClass, "derived");
    assert.equal(endpointCatalog.smart_insights.dataClass, "derived");
    assert.equal(endpointCatalog.smart_page_content.dataClass, "advisory");
  });
});

function testJwt(payload: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.y`;
}

describe("daily smart-meter ledger", () => {
  it("normalizes public cumulative registers and computes net-meter period deltas", () => {
    const html = `<div class="row"><div class="col">Consumer ID</div><div class="col">123</div></div>
      <div class="row"><div class="col">Smart Meter</div><input value="M1"></div>
      <div class="row"><div class="col">Net Meter</div><div class="col">Yes</div></div>||||
      <table id="readtable1"><tbody>
      <tr><td>2026-07-02</td><td>120</td><td>45</td><td>75</td><td>125</td><td>46</td><td>79</td></tr>
      <tr><td>2026-07-01</td><td>110</td><td>42</td><td>68</td><td>114</td><td>43</td><td>71</td></tr>
      <tr><td>2026-06-30</td><td>100</td><td>40</td><td>60</td><td>104</td><td>41</td><td>63</td></tr>
      </tbody></table>`;
    const data = parseLedgerHtml(html, "123");
    assert.equal(data.consumer.netMeter, true);
    assert.equal(data.readings.length, 3);
    const period = ledgerPeriod(data, { from: "2026-07-01", to: "2026-07-02", limit: 10 });
    assert.equal(period.period.usage?.importKwh, 20);
    assert.equal(period.period.usage?.exportKwh, 5);
    assert.equal(period.period.provisionalBillableKwh, 15);
    assert.equal(period.readings[0]?.usageSincePreviousObservation?.netImportKwh, 7);
  });
});

describe("FY 2025-26 domestic tariff", () => {
  it("matches the user's actual recent bill components", () => {
    const estimate = calculateDomesticMeteredCharges({ unitsKwh: 98, sanctionedLoadKw: 0.5 });
    assert.equal(estimate.charges.energyCharge, 225.4);
    assert.equal(estimate.charges.fixedCharge, 4);
    assert.equal(estimate.charges.totalEstimate, 229.4);
  });

  it("applies progressive slabs and load rounding", () => {
    assert.equal(calculateDomesticMeteredCharges({ unitsKwh: 220, sanctionedLoadKw: 0.5 }).charges.totalEstimate, 544);
    assert.equal(calculateDomesticMeteredCharges({ unitsKwh: 240, sanctionedLoadKw: 0.5 }).charges.totalEstimate, 624);
    const estimate = calculateDomesticMeteredCharges({ unitsKwh: 500, sanctionedLoadKw: 3 });
    assert.equal(estimate.charges.energyCharge, 1695);
    assert.equal(estimate.charges.fixedCharge, 24);
    assert.equal(estimate.charges.totalEstimate, 1719);
  });

  it("applies only explicitly eligible rebates and additional charges", () => {
    const estimate = calculateDomesticMeteredCharges({
      unitsKwh: 100,
      sanctionedLoadKw: 0.6,
      prepaid: true,
      electricityDutyAmount: 5,
      unpaidPrincipalAmount: 1000,
      lateMonths: 2,
    });
    assert.equal(estimate.charges.prepaidRebate, -4.6);
    assert.equal(estimate.charges.fixedCharge, 8);
    assert.equal(estimate.charges.latePaymentSurcharge, 30);
    assert.equal(estimate.charges.totalEstimate, 268.4);
  });
});
