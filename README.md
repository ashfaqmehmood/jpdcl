# JPDCL Smart Meter MCP

Unofficial, community-built, and MIT-licensed. This project is not affiliated with or endorsed by JPDCL, JERC, Genus, or the Government of Jammu and Kashmir.

API-only access to the JPDCL consumer portal, Genus smart-meter portal, and JPDCL daily import/export meter ledger. No browser automation is used at runtime.

## Use the hosted MCP

Add this URL to any MCP client that supports Streamable HTTP and OAuth:

```text
https://jpdcl.gododo.in/mcp
```

No API key, password flag, custom header, or environment variable is needed. Your MCP client opens the account-linking page, where you sign in to JPDCL directly. The hosted service exposes 24 read-only tools through the verified Azure/WARP path, including account records, the complete smart-meter dashboard, intervals, technical profile, reports, alerts, preferences, support, notifications, forecasts, and a guarded catalog reader. It does not expose login, payment initiation, complaint creation, preference changes, or any other account-changing action.

The only public hosted URL is `https://jpdcl.gododo.in/mcp`; the Cloudflare `workers.dev` and preview hostnames are disabled.

## Use through Smithery

[Smithery](https://smithery.ai/server/ass/jpdcl) users can install the published OAuth-enabled server directly:

```sh
npx -y smithery@latest auth login
npx -y smithery@latest mcp add ass/jpdcl --id jpdcl
```

This uses the same account-linking flow and does not put JPDCL credentials in Smithery configuration.

## Run locally with npx

Add this stdio server to any local MCP client:

```json
{
  "mcpServers": {
    "JPDCL Smart Meter": {
      "command": "npx",
      "args": ["-y", "jpdcl"]
    }
  }
}
```

Or start it directly:

```sh
npx -y jpdcl
```

On first use, ask the client to call `jpdcl_auth_login`. The local MCP saves its session with private file permissions and automatically refreshes the JPDCL and consumer-scoped Genus sessions. It exposes 27 tools, including the broader developer and explicitly guarded mutation tools.

You can also sign in and use the CLI directly:

```sh
npx -y jpdcl auth login --save-env
npx -y jpdcl snapshot
npx -y jpdcl smart health
npx -y jpdcl tariff estimate
npx -y jpdcl ledger summary
```

Use `npx -y jpdcl --help` for the complete command tree. CLI output is JSON.

## What it provides

- Consumer account, bills, payments, and billed consumption.
- Genus dashboard readings, intervals, meter health, alarms, outages, and reports.
- Daily cumulative import/export meter registers and period differences.
- Deterministic JPDCL tariff estimates with source and measurement provenance.
- A normalized `jpdcl_snapshot` intended as the default AI-facing response.

The toolkit labels stale or unavailable upstream evidence and does not present delayed portal readings as continuously live data.

## Safety

The hosted MCP is read-only. Local payments, complaints, profile changes, account linking, on-demand reads, preferences, and notification deletion remain disabled unless both `JPDCL_ENABLE_MUTATIONS=true` and an explicit confirmation are supplied.

Never commit `.env`, session files, consumer IDs, meter numbers, bills, or readings. Use `npx -y jpdcl auth logout --forget` if a device is shared or lost, and change the JPDCL password if necessary. See [SECURITY.md](./SECURITY.md) for vulnerability reporting.

## Development

Requires Bun 1.3+ and Node.js 22.12+:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun run audit:launcher
bun run audit:http
bun pm pack --dry-run
```

Live portal audits use your own private JPDCL account and must never run with credentials in CI.

## License

Released under the [MIT License](./LICENSE). Portal names, services, and data remain the property of their respective owners.
