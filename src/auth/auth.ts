import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Preview sign-in: a short list of named accounts, each with a salted scrypt
// password hash, supplied by the environment (never committed). Sessions are
// random tokens held in memory; only their SHA-256 is kept, so a memory dump
// or log line never holds a usable token. SSO and magic links replace this
// before client data (docs/WORKSPACE.md, "Access and security").

export type Role = "auditor" | "director" | "agency" | "business";
export const ROLES: readonly Role[] = ["auditor", "director", "agency", "business"];

export interface Account {
  username: string;
  displayName: string;
  role: Role;
  /** "scrypt$<N>$<salt b64>$<hash b64>" */
  passwordHash: string;
  /** For a business account: the case it can see, as "<auditor username>/<case id>". */
  linkedCase?: string;
}

export interface SessionUser {
  username: string;
  displayName: string;
  role: Role;
  linkedCase?: string;
}

const KEY_LEN = 64;
const SCRYPT_N = 16384;

export function hashPassword(password: string, salt = randomBytes(16)): string {
  const hash = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n) });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Parse PENNY_USERS: a JSON list of accounts. Bad entries are skipped with a log line. */
export function accountsFromEnv(raw = process.env.PENNY_USERS): Account[] {
  if (!raw) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    console.error("PENNY_USERS is not valid JSON; no one can sign in");
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.flatMap((a): Account[] => {
    const { username, displayName, role, passwordHash, linkedCase } = (a ?? {}) as Partial<Account>;
    if (typeof username !== "string" || !/^[A-Za-z0-9._-]{3,40}$/.test(username)) return [];
    if (typeof passwordHash !== "string" || !passwordHash.startsWith("scrypt$")) return [];
    return [{
      username,
      displayName: typeof displayName === "string" && displayName ? displayName.slice(0, 60) : username,
      role: ROLES.includes(role as Role) ? (role as Role) : "auditor",
      passwordHash,
      ...(typeof linkedCase === "string" && /^[A-Za-z0-9._-]{3,40}\/[A-Za-z0-9-]{1,30}$/.test(linkedCase) ? { linkedCase } : {}),
    }];
  });
}

const SESSION_MS = 8 * 60 * 60 * 1000;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;
// Compared against when the username is unknown, so timing doesn't reveal which names exist.
const DUMMY_HASH = hashPassword("not-a-real-password");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export type LoginResult = { ok: true; token: string; user: SessionUser } | { ok: false; reason: "invalid" | "locked" };

export class Auth {
  private readonly accounts: Map<string, Account>;
  private readonly sessions = new Map<string, { user: SessionUser; expires: number }>();
  private readonly fails = new Map<string, { since: number; count: number }>();
  private readonly clock: () => number;

  constructor(accounts: Account[], clock: () => number = Date.now) {
    this.accounts = new Map(accounts.map((a) => [a.username.toLowerCase(), a]));
    this.clock = clock;
  }

  /** The display name for a username, for showing people to each other. */
  displayNameOf(username: string): string | undefined {
    return this.accounts.get(username.toLowerCase())?.displayName;
  }

  get enabled(): boolean {
    return this.accounts.size > 0;
  }

  login(username: string, password: string): LoginResult {
    const key = username.trim().toLowerCase();
    const now = this.clock();
    const f = this.fails.get(key);
    if (f && now - f.since < FAIL_WINDOW_MS && f.count >= MAX_FAILS) return { ok: false, reason: "locked" };

    const account = this.accounts.get(key);
    const good = verifyPassword(password, account?.passwordHash ?? DUMMY_HASH) && account !== undefined;
    if (!good || !account) {
      const fresh = !f || now - f.since >= FAIL_WINDOW_MS;
      this.fails.set(key, fresh ? { since: now, count: 1 } : { since: f.since, count: f.count + 1 });
      return { ok: false, reason: "invalid" };
    }
    this.fails.delete(key);
    const token = randomBytes(32).toString("base64url");
    const user: SessionUser = { username: account.username, displayName: account.displayName, role: account.role, ...(account.linkedCase ? { linkedCase: account.linkedCase } : {}) };
    this.sessions.set(sha(token), { user, expires: now + SESSION_MS });
    if (this.sessions.size > 5000) this.sweep(now);
    return { ok: true, token, user };
  }

  user(token: string | undefined): SessionUser | undefined {
    if (!token) return undefined;
    const s = this.sessions.get(sha(token));
    if (!s) return undefined;
    if (s.expires <= this.clock()) {
      this.sessions.delete(sha(token));
      return undefined;
    }
    return s.user;
  }

  logout(token: string | undefined) {
    if (token) this.sessions.delete(sha(token));
  }

  private sweep(now: number) {
    for (const [k, s] of this.sessions) if (s.expires <= now) this.sessions.delete(k);
  }
}

export const SESSION_COOKIE = "penny_session";

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure ? "; Secure" : ""}`;
}

export function clearedCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}
