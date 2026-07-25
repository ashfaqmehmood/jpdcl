import { listEndpoints } from "../src/catalog.ts";

const origin = process.env.JPDCL_SMART_ORIGIN ?? "https://cp.rdssjpdcl.com";
const htmlResponse = await fetch(`${origin}/`);
if (!htmlResponse.ok) throw new Error(`Smart portal returned HTTP ${htmlResponse.status}`);
const html = await htmlResponse.text();
const assetPath = html.match(/(?:src=["'])(\/assets\/index-[^"']+\.js)/)?.[1];
if (!assetPath) throw new Error("Unable to locate the current smart-portal application bundle");

const bundleResponse = await fetch(new URL(assetPath, origin));
if (!bundleResponse.ok) throw new Error(`Smart-portal bundle returned HTTP ${bundleResponse.status}`);
const bundle = await bundleResponse.text();

const routes = [
  "/", "/login", "/home", "/usage", "/usage/reports", "/usage/reports/:reportId",
  "/usage/calculator", "/pay", "/pay/recharge", "/pay/payment", "/pay/autopay",
  "/pay/bill", "/pay/success", "/payment/return", "/support", "/accounts",
  "/know-your-meter", "/energy-saving-tips", "/dashboard", "/prepaid/*", "/postpaid/*",
  "/admin", "/admin/dashboard", "/admin/token", "/admin/login-counts", "/admin/feature",
];

const panels = [
  "Meter Details", "Connection", "Locate Office", "My Connections", "Payment Methods",
  "Notification Preferences", "My Alerts", "Frequently Asked Questions", "About Department",
  "Terms and Conditions", "Privacy Policy",
];

const missingRoutes = routes.filter((route) => !bundle.includes(`path:\"${route}\"`));
const missingPanels = panels.filter((panel) => !bundle.includes(panel));

function staticFragments(path) {
  return path
    .split(/\{[^}]+\}/)
    .flatMap((part) => part.split(/[?&=]/))
    .map((part) => part.replace(/\/$/, ""))
    .filter((part) => part.length >= 4 && part !== "true" && part !== "false");
}

function fragmentExists(fragment) {
  if (bundle.includes(fragment)) return true;
  const pieces = fragment.split("/").filter((piece) => piece.length >= 4);
  return pieces.length > 0 && pieces.every((piece) => bundle.includes(piece));
}

const smartEndpoints = listEndpoints("smart");
const missingEndpoints = smartEndpoints
  .filter((endpoint) => !staticFragments(endpoint.path).every(fragmentExists))
  .map((endpoint) => ({ name: endpoint.name, path: endpoint.path }));

const result = {
  origin,
  assetPath,
  routesChecked: routes.length,
  panelsChecked: panels.length,
  smartEndpointsChecked: smartEndpoints.length,
  missingRoutes,
  missingPanels,
  missingEndpoints,
  passed: missingRoutes.length === 0 && missingPanels.length === 0 && missingEndpoints.length === 0,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.passed) process.exitCode = 1;
