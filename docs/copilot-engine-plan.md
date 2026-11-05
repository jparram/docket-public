# Adding GitHub Copilot as a 4th engine

Status: **plan** (no runtime code yet). Branch: `add-copilot-engine`. Base: Docket 1.138.0 (`98e5d85`).

## Summary

Docket drives three AI "engines": `claude` (via the `@anthropic-ai/claude-agent-sdk`
`query()`), `codex` (spawns `codex app-server`, JSON-RPC), and `grok` (spawns `grok agent
stdio`, **ACP — Agent Client Protocol**, handled by the generic `engines/acp.mjs`).

GitHub Copilot CLI **supports ACP** (confirmed in GitHub's docs: "use Copilot CLI as an agent
in any third-party tools, IDEs, or automation systems that support this protocol"). It also has
`-p/--prompt` (non-interactive), `--resume`/`--continue` (resume), and a config home at
`~/.copilot` overridable via `COPILOT_HOME`. Auth is a GitHub account (`/login`) or a
fine-grained PAT via `GH_TOKEN`/`GITHUB_TOKEN` (scope: *Copilot Requests*).

**Therefore Copilot is the Grok shape, not a new paradigm.** We reuse `engines/acp.mjs`
wholesale and add a thin `copilotOptions` builder + a `copilot-home.mjs` + wiring. The engine
*key* is `copilot`; the *runtime* is `acp` (same as Grok's key `grok` → runtime `acp`).

## Must verify on a machine with Copilot CLI installed (`@github/copilot`)

These four facts gate exact code and are **not yet confirmed**; run `copilot help`,
`copilot help environment`, `copilot help logging` and inspect `~/.copilot`:

1. **ACP launch command** — the Grok-equivalent of `grok agent stdio`. Likely `copilot --acp`
   or `copilot acp`. Needed for `copilotCommand`.
2. **Sign-in status command** — the equivalent of `grok models` / `codex login status` that
   Docket can run to detect logged-in state. Possibly `copilot` + a status subcommand, or
   presence of a token file under `~/.copilot`.
3. **Model list** — which model ids Copilot exposes (e.g. `gpt-5`, `claude-sonnet-4.5`, …) for
   `gears.mjs`.
4. **Session log path/format** under `COPILOT_HOME` — only needed if we want usage; see note.

## Reference: how Grok is wired (copy this, s/grok/copilot/)

- `server.mjs:3563` `GROK_EXE` + `:3565` `grokCommand` → add `COPILOT_EXE` + `copilotCommand`.
- `server.mjs:3568` `BRANDS` → add `copilot: { name: 'Copilot', home: 'copilotHome' }`.
  (Leave `shortTools` off until ACP tool-naming is observed; Grok sets it, Codex/Claude don't.)
- `server.mjs:3602` `grokOptions` → add `copilotOptions(s, client, resume)`; set the runtime
  `engine: 'acp'` and the command to `copilotCommand([...acp args])`.
- `server.mjs:3645` `engineOptions = { grok, codex }` → add `copilot: copilotOptions`.
- `runner.mjs:22` `const ENGINES = { claude, acp, codex }` → **no change** (Copilot uses `acp`).
- `server.mjs` `envFor` (grok sets `GROK_HOME`) → set `COPILOT_HOME` when `client.copilotHome`.
- `server.mjs:250-280` `authInfo` → add a `copilot` branch (uses the status command from #2).
- `server.mjs:372/411` login / device-auth → add a `copilot` branch (GitHub `/login` or
  `GH_TOKEN`/`GITHUB_TOKEN`; device-auth only if Copilot CLI supports it).
- `server.mjs:6181` `CLI_EXE` map → add `copilot: () => fullExe(COPILOT_EXE)` (terminal).
- `server.mjs:5949` version probe → add `findTool(COPILOT_EXE, ['--version'])`.
- `gears.mjs` model/gear list → add Copilot's models (#3).
- `pricing.json` → add a `copilot` block. **Copilot is seat/subscription-based**, not per-token
  USD, so set costs to 0 / mark as subscription; do not fabricate token prices.

## New modules (mirror the Grok/Codex siblings)

- `copilot-home.mjs` — exe discovery (`findCopilotExe`, default `copilot` on PATH; override
  `PORTAL_COPILOT_EXE`), home creation at `COPILOT_HOME`, sign-in text parser (`signedInFrom`
  equivalent), device-link parser if applicable.
- `copilot-usage.mjs` — **optional / minimal.** Because `keepsChat` is true for every non-Claude
  engine, Docket keeps its own chat copy at `<data>/chats/<id>.jsonl`, so we do **not** need to
  parse Copilot logs for the conversation view. Usage/cost is the only reason to read Copilot's
  logs, and Copilot has no per-token USD — so v1 can skip cost entirely (report nothing, or a
  request count if cheap to read). Wire into the usage refresh dispatch only if implemented.

## Frontend (three brand tables + usage page)

- `index.html` — `BRAND_NAMES` / `BRAND_LOGOS`, `CO_BRANDS` (company/desk setup), `WIZ_BRANDS`
  (first-run wizard). Add a `copilot` entry + a logo/glyph.
- `usage.html` — add `copilot` to its brand list so usage rows/labels render.

## Known design mismatches (call out, don't paper over)

1. **Cost model.** Docket shows per-session USD from token counts. Copilot is flat-rate +
   premium-request quotas. The usage UI needs a "not billed per token" treatment for Copilot.
2. **Auth.** GitHub OAuth / PAT, not a Claude/ChatGPT/xAI account — new `authInfo` + login
   branch; reuse `gh`/GITHUB_TOKEN if present.
3. **save-before-compact / recall** (`recall.mjs`) is Claude-only and stays that way; Copilot's
   own auto-compaction at ~95% handles its context. No action, just don't wire Copilot into it.

## Build / test order

1. Confirm the 4 facts above on the Copilot machine.
2. Backend: `copilot-home.mjs`, `COPILOT_EXE`/`copilotCommand`, `BRANDS`, `copilotOptions`,
   `engineOptions`, `envFor`, `authInfo`, `CLI_EXE`, version probe. (Reuse `acp.mjs` as-is.)
3. Frontend: the three brand tables + `usage.html`.
4. `gears.mjs` models + `pricing.json` (zero-cost/subscription block).
5. Add a fixture + test mirroring `test/cross-brand.test.mjs` / `fake-acp-agent.mjs`
   (`PORTAL_COPILOT_EXE` → a fake ACP agent) and run `npm test`.
6. Manual: create a Copilot desk, sign in, start a session, resume it — on the Copilot machine.

## Scope / effort

~10 files, ~15–20 engine-conditional branch sites in `server.mjs` (mechanical, copy the Grok
branches). The only non-mechanical piece is representing a flat-rate product in a per-token cost
UI. Runtime is reused (`acp.mjs`), so there is **no** new protocol code.
