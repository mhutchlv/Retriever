# Penny architecture

## The promise this code enforces

Penny's credibility with carriers and insureds rests on one rule: the result depends on the evidence, never on who is asking. The plan makes deterministic settings, versioned rule tables and a run log launch requirements. This is how the code meets them.

## Layout

```
src/engine/            the audit engine (pure, no I/O)
  money.ts             exact decimal math: integer cents and scaled rates, half-up rounding
  canonical.ts         canonical JSON + SHA-256 for fingerprints
  rules/               versioned rule tables and the registry that picks them by date
  tools/               the four tools: normalize(raw) -> input, run(input, rules) -> output
  engine.ts            runTool / replayRun, run records and fingerprints
src/runlog/store.ts    run log with per-tenant retention (memory and JSON Lines)
src/chat/              keyword router (no model) and Claude tool-use loop
src/server/            HTTP API, static files, rate limits, security headers
public/                the chat-first web app (vanilla JS, Propono brand)
test/                  node:test suites
```

## One engine, one answer

A run is a pure function of four things:

1. **Tool name**
2. **Normalized input.** Each tool validates raw input and rewrites it into one canonical form (`"250,000"`, `250000` and `"$250,000.00"` all become `"250000.00"`). Defaults, including the policy effective date, are written into the normalized input, so they are recorded too. Normalizing is idempotent, which is tested for every tool.
3. **Rule versions.** The registry picks the rule set in force on the policy effective date. Every version ever shipped stays registered; corrections ship as new versions, never as edits.
4. **Engine version.** `ENGINE_VERSION` is bumped on any logic change that could change an output.

These are hashed into a **fingerprint**. Same fingerprint, same output hash, for any tenant. Tools never read the clock, randomness or the network, and all money math uses bigint cents, so floating point can't change an answer.

**Replay** re-normalizes a recorded input, checks it against the recorded input hash, re-runs with the exact recorded rule versions, and compares output hashes. A mismatch under the same engine version is a determinism bug and is reported as one.

## Retention: no input kept for free tools

The free tools promise not to keep what people type, while the plan requires a run log. Both hold:

- **`public` tenant (hashes-only):** the server stores the fingerprint, hashes, rule and engine versions, and time. It never stores input or output. The user gets the full record as a **receipt** (shown in the page; downloadable).
- **Verify:** the user sends the receipt back. The server matches it against the stored hashes (an altered receipt gets a 409), then replays it.
- **Signed-in and carrier tenants (full):** later phases store the whole record under their data terms. Carrier, standalone-business and partner data stay walled off by tenant; only rules and logic are shared.

## Chat

- **Without a model:** `chat/router.ts` maps the message to a tool. It runs class code lookups directly and opens the right form for everything else.
- **With a model:** `chat/claude.ts` runs a tool-use loop. The system prompt forbids the model from doing arithmetic or stating figures that don't come from a tool result. Every tool call goes through `runTool`, so it is logged like any other run. Server-side refusal fallback is enabled (`fallbacks: "default"`). If the model call fails, chat falls back to the router.

## Data still to load before public launch

| Rule set | Status | Replace with |
| --- | --- | --- |
| `class-codes` | sample seed (~30 codes) | WCIRB, NYCIRB and PCRB public tables; NCCI under license. Short titles only until the NCCI license is signed. |
| `officer-payroll` | sample placeholder limits | Each bureau's current officer and owner limits |
| `jurisdictions` | sample | Confirm the bureau map |
| `audit-checklist` | verified (Propono practice) | Cliff to review |

## Next phases (from the plan)

- **Phase 2, auditors:** accounts and auth, Pro and Max metering, email intake, signed-in 941 reconciliation and certificate checker (document reading with Claude, numbers still from the engine).
- **Phase 3, agencies:** Audit Ready, partner seats, Statement Insurance as the pilot partner.
- **Phase 4, carrier dispute module:** line-by-line explanations, evidence upload, auditor approve or deny, regenerated audit; enterprise only.

Production hardening still to do: a database-backed run log, a shared rate limiter, structured logging, and a deploy target.
