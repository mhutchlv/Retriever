import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Spend control for the model-backed chat. Every model call is priced from the
// API's own usage counts and charged against three daily limits (UTC day):
//   - a global dollar cap for the whole site,
//   - a per-visitor dollar cap,
//   - a per-visitor message cap.
// When any limit is reached, chat falls back to Penny's built-in answers (no
// model cost) until the next UTC day. A concurrency cap bounds how far in-flight
// calls can overshoot the global cap. State is kept per day in a small JSON file
// on the data share, so restarts and scale-to-zero don't reset the counters.
// Visitor keys are salted hashes; raw IP addresses are never written to disk.

/** Dollars per million tokens. */
export interface Pricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Claude Sonnet 5.5 list prices; cache writes are 1.25x input for the 5-minute cache. */
export const SONNET_5_5: Pricing = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Cost of one API response in micro-dollars (integers, so totals never drift). */
export function costMicros(usage: Usage, p: Pricing): number {
  const dollarsTimesMillion =
    usage.input_tokens * p.input +
    usage.output_tokens * p.output +
    (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite +
    (usage.cache_read_input_tokens ?? 0) * p.cacheRead;
  // tokens x ($ per 1M tokens) = micro-dollars
  return Math.ceil(dollarsTimesMillion);
}

export interface BudgetLimits {
  /** Whole-site model spend per UTC day, in dollars. */
  dailyUsd: number;
  /** One visitor's model spend per UTC day, in dollars. */
  perVisitorUsd: number;
  /** One visitor's model-answered messages per UTC day. */
  perVisitorMessages: number;
  /** Model calls allowed in flight at once. */
  maxConcurrent: number;
}

export const DEFAULT_LIMITS: BudgetLimits = { dailyUsd: 10, perVisitorUsd: 0.5, perVisitorMessages: 40, maxConcurrent: 4 };

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): BudgetLimits {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    dailyUsd: num(env.PENNY_CHAT_DAILY_USD, DEFAULT_LIMITS.dailyUsd),
    perVisitorUsd: num(env.PENNY_CHAT_VISITOR_USD, DEFAULT_LIMITS.perVisitorUsd),
    perVisitorMessages: num(env.PENNY_CHAT_VISITOR_MESSAGES, DEFAULT_LIMITS.perVisitorMessages),
    maxConcurrent: Math.max(1, num(env.PENNY_CHAT_MAX_CONCURRENT, DEFAULT_LIMITS.maxConcurrent)),
  };
}

export type DenyReason = "daily_budget" | "visitor_budget" | "visitor_messages" | "busy";

interface DayState {
  day: string;
  spentMicros: number;
  calls: number;
  visitors: Record<string, { micros: number; messages: number }>;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class ChatBudget {
  private state: DayState;
  private inFlight = 0;
  private readonly limits: BudgetLimits;
  private readonly file: string | undefined;
  private readonly salt: string;
  private readonly clock: () => number;

  constructor(opts: { limits?: BudgetLimits; file?: string; salt?: string; clock?: () => number } = {}) {
    this.limits = opts.limits ?? DEFAULT_LIMITS;
    this.file = opts.file;
    this.salt = opts.salt ?? "penny";
    this.clock = opts.clock ?? Date.now;
    this.state = this.load();
  }

  /** Salted hash of a client address, so the state file never holds an IP. */
  visitorId(clientKey: string): string {
    return createHash("sha256").update(`${this.salt}:${clientKey}`).digest("hex").slice(0, 16);
  }

  private today(): DayState {
    const day = utcDay(this.clock());
    if (this.state.day !== day) this.state = { day, spentMicros: 0, calls: 0, visitors: {} };
    return this.state;
  }

  /**
   * Ask to start a model-answered message. On success the caller must call
   * finish() exactly once (charge the usage, or zero if the call failed).
   */
  begin(clientKey: string): { ok: true; visitor: string } | { ok: false; reason: DenyReason } {
    const s = this.today();
    const visitor = this.visitorId(clientKey);
    const v = s.visitors[visitor] ?? { micros: 0, messages: 0 };
    if (s.spentMicros >= this.limits.dailyUsd * 1e6) return { ok: false, reason: "daily_budget" };
    if (v.micros >= this.limits.perVisitorUsd * 1e6) return { ok: false, reason: "visitor_budget" };
    if (v.messages >= this.limits.perVisitorMessages) return { ok: false, reason: "visitor_messages" };
    if (this.inFlight >= this.limits.maxConcurrent) return { ok: false, reason: "busy" };
    this.inFlight += 1;
    v.messages += 1;
    s.visitors[visitor] = v;
    return { ok: true, visitor };
  }

  /** Record what a message actually cost (sum of every API call it made). */
  finish(visitor: string, micros: number, calls: number): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const s = this.today();
    const v = s.visitors[visitor] ?? { micros: 0, messages: 0 };
    v.micros += micros;
    s.visitors[visitor] = v;
    s.spentMicros += micros;
    s.calls += calls;
    this.save();
  }

  snapshot(): { day: string; spentUsd: number; capUsd: number; calls: number; visitors: number } {
    const s = this.today();
    return { day: s.day, spentUsd: s.spentMicros / 1e6, capUsd: this.limits.dailyUsd, calls: s.calls, visitors: Object.keys(s.visitors).length };
  }

  private load(): DayState {
    const empty: DayState = { day: utcDay(this.clock()), spentMicros: 0, calls: 0, visitors: {} };
    if (!this.file || !existsSync(this.file)) return empty;
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as DayState;
      return saved.day === empty.day && typeof saved.spentMicros === "number" ? saved : empty;
    } catch {
      return empty;
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.state));
    } catch (err) {
      console.error("could not save chat budget state", err);
    }
  }
}

/** What the visitor sees when chat drops to built-in answers. */
export function fallbackNotice(reason: DenyReason): string {
  switch (reason) {
    case "busy":
      return "Penny is busy right now, so here's the quick answer.";
    case "daily_budget":
      return "Penny's detailed answers are paused for today, so here's the quick answer. The free tools still work in full.";
    case "visitor_budget":
    case "visitor_messages":
      return "You've reached today's limit for detailed answers, so here's the quick answer. The free tools still work in full, and detailed answers come back tomorrow.";
  }
}
