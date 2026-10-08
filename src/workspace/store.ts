import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hashOf } from "../engine/canonical.ts";
import { InputError, toCents, formatScaled } from "../engine/money.ts";
import { asObject, classCode, optString, reqString } from "../engine/validate.ts";
import { AUDIT_STATUSES, computeCase, type AuditStatus, type Case, type TimelineEvent } from "./model.ts";
import { sampleCases } from "./seed.ts";

// Workspace actions: the one way a case changes, used by the buttons and by
// Penny alike. Each applied action appends a hash-chained timeline event with
// who, when, before and after, the reason, and the premium effect. Undo is a
// new event; nothing is removed.

export type Action =
  | { type: "set_status"; status: AuditStatus; reason?: string }
  | { type: "update_line"; lineId: string; classCode?: string; payroll?: string; overtimePremium?: string; overtimeExcluded?: boolean; reason: string }
  | { type: "set_officer"; officerId: string; status?: "included" | "excluded"; classCode?: string; reason: string }
  | { type: "set_sub"; subId: string; treatment?: "insured" | "uninsured"; classCode?: string; reason: string }
  | { type: "set_finding"; findingId: string; status: "open" | "accepted" | "rejected"; reason?: string }
  | { type: "clear_flag"; lineId: string; reason: string }
  | { type: "add_note"; text: string }
  | { type: "set_operations"; text: string; reason?: string }
  | { type: "request_coi"; subId: string }
  | { type: "undo"; seq: number };

export const ACTION_TYPES = ["set_status", "update_line", "set_officer", "set_sub", "set_finding", "clear_flag", "add_note", "set_operations", "request_coi", "undo"] as const;

/** Statuses that produce or rely on the audit report, which needs a description of operations. */
const REPORT_STATUSES: readonly AuditStatus[] = ["Draft ready", "Director review", "Submitted to carrier", "Final"];

export interface ChangeCard {
  action: Action;
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  premium?: { before: string; after: string; change: string };
  movesMoney: boolean;
}

const reason = (v: unknown, required: boolean) => {
  const r = optString(v, "reason", 300);
  if (required && !r) throw new InputError("reason", "a short reason is required for this change");
  return r;
};
const amount = (v: unknown, field: string) => {
  const c = toCents(v, field);
  if (c < 0n) throw new InputError(field, "cannot be negative");
  return formatScaled(c, 2);
};

/** Validate an action from the browser or from Penny. */
export function parseAction(raw: unknown): Action {
  const o = asObject(raw, "action");
  const type = o.type;
  switch (type) {
    case "set_status": {
      const status = AUDIT_STATUSES.find((s) => s === o.status);
      if (!status) throw new InputError("status", `must be one of: ${AUDIT_STATUSES.join(", ")}`);
      const r = reason(o.reason, false);
      return { type, status, ...(r ? { reason: r } : {}) };
    }
    case "update_line":
      return {
        type,
        lineId: reqString(o.lineId, "lineId", 20),
        ...(o.classCode !== undefined ? { classCode: classCode(o.classCode, "classCode") } : {}),
        ...(o.payroll !== undefined ? { payroll: amount(o.payroll, "payroll") } : {}),
        ...(o.overtimePremium !== undefined ? { overtimePremium: amount(o.overtimePremium, "overtimePremium") } : {}),
        ...(typeof o.overtimeExcluded === "boolean" ? { overtimeExcluded: o.overtimeExcluded } : {}),
        reason: reason(o.reason, true)!,
      };
    case "set_officer":
      return {
        type,
        officerId: reqString(o.officerId, "officerId", 20),
        ...(o.status === "included" || o.status === "excluded" ? { status: o.status } : {}),
        ...(o.classCode !== undefined ? { classCode: classCode(o.classCode, "classCode") } : {}),
        reason: reason(o.reason, true)!,
      };
    case "set_sub":
      return {
        type,
        subId: reqString(o.subId, "subId", 20),
        ...(o.treatment === "insured" || o.treatment === "uninsured" ? { treatment: o.treatment } : {}),
        ...(o.classCode !== undefined ? { classCode: classCode(o.classCode, "classCode") } : {}),
        reason: reason(o.reason, true)!,
      };
    case "set_finding": {
      if (o.status !== "open" && o.status !== "accepted" && o.status !== "rejected") throw new InputError("status", "must be open, accepted or rejected");
      const r = reason(o.reason, false);
      return { type, findingId: reqString(o.findingId, "findingId", 20), status: o.status, ...(r ? { reason: r } : {}) };
    }
    case "clear_flag":
      return { type, lineId: reqString(o.lineId, "lineId", 20), reason: reason(o.reason, true)! };
    case "add_note":
      return { type, text: reqString(o.text, "text", 2000) };
    case "request_coi":
      return { type, subId: reqString(o.subId, "subId", 20) };
    case "set_operations": {
      const r = reason(o.reason, false);
      return { type, text: reqString(o.text, "text", 4000), ...(r ? { reason: r } : {}) };
    }
    case "undo": {
      const seq = o.seq;
      if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) throw new InputError("seq", "must be a timeline event number");
      return { type, seq };
    }
    default:
      throw new InputError("type", `must be one of: ${ACTION_TYPES.join(", ")}`);
  }
}

type Mutation = { summary: string; target?: string; before?: Record<string, unknown>; after?: Record<string, unknown>; reason?: string; undoes?: number; movesMoney: boolean };

const pick = (obj: object, keys: string[]) => Object.fromEntries(keys.map((k) => [k, (obj as Record<string, unknown>)[k]]));

function find<T extends { id: string }>(list: T[], id: string, what: string): T {
  const item = list.find((x) => x.id === id);
  if (!item) throw new InputError(what, `no ${what} ${id} on this case`);
  return item;
}

function setFields(target: object, after: Record<string, unknown>) {
  for (const [k, v] of Object.entries(after)) {
    if (v === undefined) delete (target as Record<string, unknown>)[k];
    else (target as Record<string, unknown>)[k] = v;
  }
}

/** Apply an action to a case in place and describe what changed. */
function mutate(c: Case, action: Action, actor: string): Mutation {
  switch (action.type) {
    case "set_status": {
      if (REPORT_STATUSES.includes(action.status) && !c.operations?.trim()) {
        throw new InputError("status", "write the description of operations first; the audit report needs it");
      }
      const before = { status: c.status };
      c.status = action.status;
      return { summary: `Status set to ${action.status}`, target: "status", before, after: { status: c.status }, ...(action.reason ? { reason: action.reason } : {}), movesMoney: false };
    }
    case "update_line": {
      const l = find(c.lines, action.lineId, "line");
      const changes: Record<string, unknown> = {};
      if (action.classCode !== undefined) changes.classCode = action.classCode;
      if (action.payroll !== undefined) changes.payroll = action.payroll;
      if (action.overtimePremium !== undefined) changes.overtimePremium = action.overtimePremium;
      if (action.overtimeExcluded !== undefined) changes.overtimeExcluded = action.overtimeExcluded;
      if (!Object.keys(changes).length) throw new InputError("action", "nothing to change");
      // A person's decision on the line settles Penny's question about it.
      if (l.flag) changes.flag = undefined;
      changes.setBy = actor === "Penny" ? "penny" : "person";
      const before = pick(l, Object.keys(changes));
      setFields(l, changes);
      const parts = [
        action.classCode !== undefined && `class ${before.classCode} to ${action.classCode}`,
        action.payroll !== undefined && `payroll to $${action.payroll}`,
        action.overtimePremium !== undefined && `overtime premium to $${action.overtimePremium}`,
        action.overtimeExcluded !== undefined && (action.overtimeExcluded ? "overtime premium left out" : "overtime premium counted"),
      ].filter(Boolean);
      return { summary: `${l.payee}: ${parts.join(", ")}`, target: `line:${l.id}`, before, after: changes, reason: action.reason, movesMoney: true };
    }
    case "set_officer": {
      const o = find(c.officers, action.officerId, "officer");
      const changes: Record<string, unknown> = {};
      if (action.status) changes.status = action.status;
      if (action.classCode) changes.classCode = action.classCode;
      if (!Object.keys(changes).length) throw new InputError("action", "nothing to change");
      const before = pick(o, Object.keys(changes));
      setFields(o, changes);
      return { summary: `${o.name}: ${Object.entries(changes).map(([k, v]) => `${k === "classCode" ? "class" : k} ${v}`).join(", ")}`, target: `officer:${o.id}`, before, after: changes, reason: action.reason, movesMoney: true };
    }
    case "set_sub": {
      const s = find(c.subs, action.subId, "subcontractor");
      const changes: Record<string, unknown> = {};
      if (action.treatment) changes.treatment = action.treatment;
      if (action.classCode) changes.classCode = action.classCode;
      if (!Object.keys(changes).length) throw new InputError("action", "nothing to change");
      const before = pick(s, Object.keys(changes));
      setFields(s, changes);
      return { summary: `${s.name}: ${Object.entries(changes).map(([k, v]) => `${k === "classCode" ? "class" : "treated as"} ${v}`).join(", ")}`, target: `sub:${s.id}`, before, after: changes, reason: action.reason, movesMoney: true };
    }
    case "set_finding": {
      const f = find(c.findings, action.findingId, "finding");
      const before = { status: f.status };
      f.status = action.status;
      return { summary: `Finding "${f.title}" marked ${action.status}`, target: `finding:${f.id}`, before, after: { status: f.status }, ...(action.reason ? { reason: action.reason } : {}), movesMoney: false };
    }
    case "clear_flag": {
      const l = find(c.lines, action.lineId, "line");
      if (!l.flag) throw new InputError("lineId", "that line has no open flag");
      const before = { flag: l.flag };
      delete l.flag;
      return { summary: `Flag cleared on ${l.payee}, kept as is`, target: `line:${l.id}`, before, after: { flag: undefined }, reason: action.reason, movesMoney: false };
    }
    case "request_coi": {
      const s = find(c.subs, action.subId, "subcontractor");
      const before = { coiRequestedAt: s.coiRequestedAt };
      s.coiRequestedAt = new Date().toISOString().slice(0, 10);
      return { summary: `Certificate of insurance requested from ${s.name}`, target: `sub:${s.id}`, before, after: { coiRequestedAt: s.coiRequestedAt }, movesMoney: false };
    }
    case "set_operations": {
      const before = { operations: c.operations ?? "" };
      c.operations = action.text;
      return { summary: before.operations ? "Description of operations updated" : "Description of operations written", target: "operations", before, after: { operations: c.operations }, ...(action.reason ? { reason: action.reason } : {}), movesMoney: false };
    }
    case "add_note":
      c.notes.push({ at: new Date().toISOString(), author: actor, text: action.text });
      return { summary: `Note added: ${action.text.slice(0, 120)}`, movesMoney: false };
    case "undo": {
      const e = c.timeline.find((x) => x.seq === action.seq);
      if (!e || !e.target || !e.before || !e.after) throw new InputError("seq", "that event can't be undone");
      const entity = entityFor(c, e.target);
      const current = pick(entity, Object.keys(e.after));
      if (hashOf(current) !== hashOf(e.after)) throw new InputError("seq", "the item has changed since then; undo the later change first");
      const before = current;
      setFields(entity, e.before);
      return { summary: `Undid #${e.seq}: ${e.summary}`, target: e.target, before, after: e.before, undoes: e.seq, movesMoney: e.premium !== undefined };
    }
  }
}

function entityFor(c: Case, target: string): object {
  if (target === "status" || target === "operations") return c;
  const [kind, id = ""] = target.split(":");
  if (kind === "line") return find(c.lines, id, "line");
  if (kind === "officer") return find(c.officers, id, "officer");
  if (kind === "sub") return find(c.subs, id, "subcontractor");
  if (kind === "finding") return find(c.findings, id, "finding");
  throw new InputError("target", "unknown");
}

const premiumOf = (c: Case, tenant: string) => computeCase(c, tenant).estimate?.totalAuditPremium;

function signed(cents: number): string {
  const sign = cents > 0 ? "+" : cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

function appendEvent(c: Case, e: Omit<TimelineEvent, "seq" | "prevHash" | "hash">): TimelineEvent {
  const prevHash = c.timeline.at(-1)?.hash ?? "0".repeat(64);
  const body = { ...e, seq: c.timeline.length + 1, prevHash };
  const event = { ...body, hash: hashOf(body) } as TimelineEvent;
  c.timeline.push(event);
  return event;
}

/** Check the timeline's hash chain. Any edited or removed event breaks it. */
export function verifyTimeline(c: Case): { ok: boolean; events: number; brokenAt?: number } {
  let prev = "0".repeat(64);
  for (const e of c.timeline) {
    const { hash, ...body } = e;
    if (e.prevHash !== prev || hashOf(body) !== hash) return { ok: false, events: c.timeline.length, brokenAt: e.seq };
    prev = hash;
  }
  return { ok: true, events: c.timeline.length };
}

export const tenantFor = (username: string) => `ws:${username.toLowerCase()}`;

export class WorkspaceStore {
  private readonly data: Record<string, Case[]> = {};
  private readonly file: string | undefined;

  constructor(file?: string) {
    this.file = file;
    if (file && existsSync(file)) {
      try {
        Object.assign(this.data, (JSON.parse(readFileSync(file, "utf8")) as { workspaces: Record<string, Case[]> }).workspaces);
        // Cases saved before the description of operations existed get the sample text.
        for (const [user, list] of Object.entries(this.data)) {
          const seeds = sampleCases(user);
          for (const c of list) {
            const seed = seeds.find((s) => s.data.id === c.id)?.data;
            c.operations ??= seed?.operations ?? "";
            // Subcontractors saved before certificates had dates come back from the sample set.
            if (c.subs.some((s) => !Array.isArray((s as { cois?: unknown }).cois))) {
              c.subs = structuredClone(seed?.subs ?? []);
              for (const d of seed?.documents ?? []) if (!c.documents.some((x) => x.id === d.id)) c.documents.push(d);
              for (const f of seed?.findings ?? []) if (!c.findings.some((x) => x.id === f.id)) c.findings.push(f);
            }
          }
        }
      } catch (err) {
        console.error("workspace file unreadable; starting fresh", err);
      }
    }
  }

  cases(username: string): Case[] {
    const key = username.toLowerCase();
    if (!this.data[key]) {
      this.data[key] = sampleCases(username).map(({ data, events }) => {
        const c: Case = { ...data, timeline: [] };
        for (const e of events) appendEvent(c, { at: e.at, actor: e.actor, via: e.actor === "Penny" ? "penny" : "workspace", action: e.action, summary: e.summary });
        return c;
      });
      this.save();
    }
    return this.data[key];
  }

  get(username: string, id: string): Case | undefined {
    return this.cases(username).find((c) => c.id === id);
  }

  /** What an action would do, without doing it. Used for Penny's change cards. */
  preview(username: string, id: string, action: Action, actor: string): ChangeCard {
    const c = this.require(username, id);
    const copy = structuredClone(c);
    const before = premiumOf(copy, tenantFor(username));
    const m = mutate(copy, action, actor);
    const after = premiumOf(copy, tenantFor(username));
    return {
      action,
      summary: m.summary,
      ...(m.before ? { before: m.before } : {}),
      ...(m.after ? { after: m.after } : {}),
      ...(m.movesMoney && before && after ? { premium: { before: before.display, after: after.display, change: signed(after.cents - before.cents) } } : {}),
      movesMoney: m.movesMoney,
    };
  }

  apply(username: string, id: string, action: Action, actor: string, via: "workspace" | "penny"): TimelineEvent {
    const c = this.require(username, id);
    const tenant = tenantFor(username);
    const work = structuredClone(c);
    const before = premiumOf(work, tenant);
    const m = mutate(work, action, actor);
    const after = premiumOf(work, tenant);
    const event = appendEvent(work, {
      at: new Date().toISOString(),
      actor,
      via,
      action: action.type,
      summary: m.summary,
      ...(m.target ? { target: m.target } : {}),
      ...(m.before ? { before: m.before } : {}),
      ...(m.after ? { after: m.after } : {}),
      ...(m.reason ? { reason: m.reason } : {}),
      ...(m.movesMoney && before && after ? { premium: { before: before.display, after: after.display } } : {}),
      ...(m.undoes ? { undoes: m.undoes } : {}),
    });
    const list = this.cases(username);
    list[list.indexOf(c)] = work;
    this.save();
    return event;
  }

  /** Put the sample cases back to their starting point. */
  reset(username: string) {
    delete this.data[username.toLowerCase()];
    this.cases(username);
  }

  private require(username: string, id: string): Case {
    const c = this.get(username, id);
    if (!c) throw new InputError("case", `no case ${id}`);
    return c;
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, workspaces: this.data }));
    renameSync(tmp, this.file);
  }
}
