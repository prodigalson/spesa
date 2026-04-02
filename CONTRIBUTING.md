# Contributing to spesa

## Project structure

```
src/
  version.ts                  ← single source of truth for version
  index.ts                    ← CLI entry point (commander)
  mcp.ts                      ← MCP server entry point
  output.ts                   ← JSON/table output helpers
  session.ts                  ← cookie persistence (~/.spesa/sessions/)
  types.ts                    ← all TypeScript interfaces
  platforms/
    esselunga/
      index.ts                ← EsselungaClient (browser automation)
scripts/
  bump.ts                     ← version bump script
```

## Setup

```bash
bun install
bunx playwright install webkit
```

## Running

```bash
bun run dev                   # CLI (direct, no build)
bun run mcp                   # MCP server (stdio)
bun run typecheck             # type check (no emit)
```

## Adding a new command

1. Add the client method to `src/platforms/esselunga/index.ts`
2. Add any new types to `src/types.ts`
3. Add the CLI command to `src/index.ts`
4. Add the MCP tool to `src/mcp.ts` (tool definition + handler in the switch)
5. Update `SKILL.md` with the new MCP tool docs
6. Update `README.md` with the new CLI command

Both CLI and MCP must expose the same functionality. The MCP server is the primary
interface for agents, the CLI is for humans.

## Releasing a new version

One command:

```bash
bun run bump patch            # 0.2.1 → 0.2.2
bun run bump minor            # 0.2.1 → 0.3.0
bun run bump major            # 0.2.1 → 1.0.0
bun run bump 1.0.0            # set exact version
```

This updates `src/version.ts`, `package.json`, and `SKILL.md` in one shot. Then:

```bash
git add -A
git commit -m "chore: bump to vX.Y.Z"
git push
```

**Never edit the version manually** in package.json, SKILL.md, index.ts, or mcp.ts.
They all read from `src/version.ts`. The bump script keeps them in sync.

## Architecture notes

- **No public API.** Esselunga has no API. Everything is browser automation via Playwright WebKit.
- **Each client method launches a fresh browser.** Stateless by design. Session cookies are loaded from disk.
- **WebKit, not Chromium.** Esselunga's WAF blocks Playwright Chromium. WebKit with Safari UA works.
- **DOM scraping with API interception fallback.** Search intercepts XHR responses first, falls back to scraping `div.product[id]` cards.
- **8s SPA wait replaced with DOM-ready polling.** Polls for AngularJS bootstrap or target element, up to 15s.

## Adding a new platform

The architecture supports multiple platforms (the `esselunga` subcommand). To add another:

1. Create `src/platforms/<name>/index.ts` with a client class
2. Add a new commander subcommand group in `src/index.ts`
3. Add MCP tools in `src/mcp.ts` (prefix tool names with the platform if needed)
4. Add session support in `src/session.ts` (already keyed by platform name)
