import type { SessionUser } from "../auth/auth.ts";
import { computeCase, type AuditStatus, type Case } from "./model.ts";
import { tenantFor, type WorkspaceStore } from "./store.ts";

// The director's team board: every open audit across the team, what's due or
// overdue, what's waiting on review, and where cases are stuck. In the preview
// the signed-in auditor's own cases are live; the rest of the team is a fixed
// sample so the board looks like a real team.

const DAY = 86_400_000;
const OPEN_DONE: AuditStatus[] = ["Final", "Cancelled"];
const REVIEW: AuditStatus[] = ["Draft ready", "Director review"];

export interface BoardRow {
  id: string;
  live: boolean;
  auditor: string;
  insured: string;
  state: string;
  status: string;
  dueDate: string;
  daysOpen: number;
  daysToDue: number;
  openFlags: number;
  openFindings: number;
  coiGaps: number;
  premium?: string;
  difference?: { display: string; result: string };
}

const SAMPLE_TEAM: Omit<BoardRow, "daysToDue">[] = [
  { id: "T-101", live: false, auditor: "Maria Reyes", insured: "Canyon View Dental Group", state: "NV", status: "In review", dueDate: "2026-10-15", daysOpen: 34, openFlags: 0, openFindings: 1, coiGaps: 0, premium: "$3,184.20", difference: { display: "$212.40", result: "additional premium" } },
  { id: "T-102", live: false, auditor: "Maria Reyes", insured: "Red Rock Framing LLC", state: "NV", status: "Director review", dueDate: "2026-10-12", daysOpen: 41, openFlags: 0, openFindings: 2, coiGaps: 1, premium: "$48,906.75", difference: { display: "$9,812.30", result: "additional premium" } },
  { id: "T-103", live: false, auditor: "Maria Reyes", insured: "Sunrise Home Health", state: "AZ", status: "Waiting on insured", dueDate: "2026-10-05", daysOpen: 52, openFlags: 1, openFindings: 1, coiGaps: 0 },
  { id: "T-104", live: false, auditor: "James Patel", insured: "Mesa Auto Repair", state: "AZ", status: "Records received", dueDate: "2026-10-28", daysOpen: 12, openFlags: 0, openFindings: 0, coiGaps: 0 },
  { id: "T-105", live: false, auditor: "James Patel", insured: "Silver State Plumbing Inc.", state: "NV", status: "Draft ready", dueDate: "2026-10-14", daysOpen: 29, openFlags: 0, openFindings: 1, coiGaps: 0, premium: "$21,407.10", difference: { display: "$1,960.00", result: "return premium" } },
  { id: "T-106", live: false, auditor: "James Patel", insured: "High Desert Hauling", state: "NV", status: "Records requested", dueDate: "2026-11-20", daysOpen: 6, openFlags: 0, openFindings: 0, coiGaps: 0 },
  { id: "T-107", live: false, auditor: "Maria Reyes", insured: "Lakeside Property Management", state: "NV", status: "Scheduled", dueDate: "2026-11-30", daysOpen: 3, openFlags: 0, openFindings: 0, coiGaps: 0 },
];

const daysBetween = (from: string, to: number) => Math.floor((to - Date.parse(from)) / DAY);

function liveRow(c: Case, auditor: string, now: number): BoardRow {
  const t = computeCase(c, tenantFor(c.assignee));
  const opened = c.timeline[0]?.at ?? c.policyExpirationDate;
  const cmp = t.estimate?.comparison;
  return {
    id: c.id,
    live: true,
    auditor,
    insured: c.insured,
    state: c.state,
    status: c.status,
    dueDate: c.dueDate,
    daysOpen: Math.max(0, daysBetween(opened, now)),
    daysToDue: -daysBetween(c.dueDate, now),
    openFlags: t.openFlags,
    openFindings: t.openFindings,
    coiGaps: Object.values(t.subs).filter((s) => s.status !== "full").length,
    ...(t.estimate ? { premium: t.estimate.totalAuditPremium.display } : {}),
    ...(cmp ? { difference: { display: cmp.difference.display, result: cmp.result } } : {}),
  };
}

export function directorBoard(user: SessionUser, store: WorkspaceStore, now = Date.now()) {
  const live = store.cases(user.username).map((c) => liveRow(c, user.displayName, now));
  const sample = SAMPLE_TEAM.map((r) => ({ ...r, daysToDue: -daysBetween(r.dueDate, now) }));
  const rows = [...live, ...sample].filter((r) => !OPEN_DONE.includes(r.status as AuditStatus));

  const auditors = [...new Set(rows.map((r) => r.auditor))];
  const byAuditor = auditors.map((a) => {
    const mine = rows.filter((r) => r.auditor === a);
    return {
      auditor: a,
      live: mine.some((r) => r.live),
      open: mine.length,
      dueThisWeek: mine.filter((r) => r.daysToDue >= 0 && r.daysToDue <= 7).length,
      overdue: mine.filter((r) => r.daysToDue < 0).length,
      inReview: mine.filter((r) => REVIEW.includes(r.status as AuditStatus)).length,
      waitingOnInsured: mine.filter((r) => r.status === "Waiting on insured").length,
      flags: mine.reduce((n, r) => n + r.openFlags, 0),
    };
  });

  const attention = rows
    .flatMap((r) => [
      ...(r.daysToDue < 0 ? [{ id: r.id, live: r.live, insured: r.insured, auditor: r.auditor, kind: "overdue", text: `Overdue by ${-r.daysToDue} day${r.daysToDue === -1 ? "" : "s"}` }] : []),
      ...(r.status === "Waiting on insured" && r.daysOpen > 30 ? [{ id: r.id, live: r.live, insured: r.insured, auditor: r.auditor, kind: "stalled", text: `Waiting on the insured, open ${r.daysOpen} days` }] : []),
      ...(r.coiGaps ? [{ id: r.id, live: r.live, insured: r.insured, auditor: r.auditor, kind: "coi", text: `${r.coiGaps} subcontractor${r.coiGaps === 1 ? "" : "s"} without full certificate coverage` }] : []),
      ...(REVIEW.includes(r.status as AuditStatus) && r.openFlags ? [{ id: r.id, live: r.live, insured: r.insured, auditor: r.auditor, kind: "flags", text: `In review with ${r.openFlags} open flag${r.openFlags === 1 ? "" : "s"}` }] : []),
    ])
    .slice(0, 12);

  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  return {
    team: {
      open: rows.length,
      dueThisWeek: rows.filter((r) => r.daysToDue >= 0 && r.daysToDue <= 7).length,
      overdue: rows.filter((r) => r.daysToDue < 0).length,
      awaitingReview: rows.filter((r) => REVIEW.includes(r.status as AuditStatus)).length,
      waitingOnInsured: rows.filter((r) => r.status === "Waiting on insured").length,
      averageDaysOpen: rows.length ? Math.round(rows.reduce((n, r) => n + r.daysOpen, 0) / rows.length) : 0,
    },
    byStatus,
    byAuditor,
    reviewQueue: rows.filter((r) => REVIEW.includes(r.status as AuditStatus)).sort((a, b) => a.daysToDue - b.daysToDue),
    attention,
    cases: rows.sort((a, b) => a.daysToDue - b.daysToDue),
    note: "Your own cases are live. The other auditors' cases are sample data so the board looks like a full team.",
  };
}
