# Penny by Propono

Chat-first workers' comp premium audit helper. See README.md and docs/ARCHITECTURE.md.

## Commands

- `npm run check`: typecheck and tests. Run before every commit.
- `npm start`: serve on :3000.

## Engine rules (do not break)

- Tools are pure: no clock, randomness, network or file access inside `run()`. Money is bigint cents via `src/engine/money.ts`, never floats.
- `normalize()` must be idempotent and must write defaults into the input it returns.
- Never edit a shipped rule set version. Add a new version with a later `effectiveFrom` or a new version string.
- Bump `ENGINE_VERSION` when tool logic could change an output.
- Data not checked against the governing bureau is `status: "sample"` and must stay visibly labeled.
- No NCCI manual text beyond short class code titles until the NCCI license is signed.

## Chat and site

- `src/chat/knowledge.ts` `FACTS` is what the homepage salesperson may say about plans, prices and availability. Keep it in step with `public/index.html` and `src/chat/sales.ts`.
- Demos may use sample businesses and demo rates, but every dollar figure must come from an engine run.
- Never collect contact details through the model; sign-ups go through the consent form to `/api/leads`.

## Copy rules

- Promise accuracy and explanation, never lower premiums. Penny is a "neutral first review," never an "arbiter."
- Do not use "automate," "automation" or "automated" in auditor- or carrier-facing copy. Use "lighter review," "earned trust," "cleared without changes."
- Sentence case for UI labels and headings. Footer: "© 2026 Propono Systems Inc."
