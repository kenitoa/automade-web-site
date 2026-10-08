import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { HttpError } from "../http";
import { audit, hash, many, now, one, text, transaction, type SqlRow } from "./common";
export type Role = "owner" | "editor" | "reviewer" | "operator" | "visitor";
export interface Identity { accountId: string | null; csrf: string; tokenHash: string; localOwner: boolean; }
const cookieName = (scope: string): string => `automade-platform-${hash(scope).slice(0, 12)}`;
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
export function email(value: unknown): string {
  const result = text(value, "이메일", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new HttpError(400, "EMAIL", "이메일 형식을 확인하세요.");
  return result;
}
export async function passwordHash(value: unknown): Promise<string> {
  const password = text(value, "비밀번호", 128);
  if (password.length < 12) throw new HttpError(400, "PASSWORD", "비밀번호는 12자 이상이어야 합니다.");
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPasswordHash(password: string, encoded: string | null): Promise<boolean> {
  const parts = (encoded ?? `scrypt:${"0".repeat(32)}:${"0".repeat(128)}`).split(":");
  const valid = parts[0] === "scrypt" && /^[a-f0-9]{32}$/.test(parts[1] ?? "") && /^[a-f0-9]{128}$/.test(parts[2] ?? "");
  const derived = await derive(password, valid ? parts[1]! : "0".repeat(32));
  return Boolean(encoded && valid && timingSafeEqual(derived, Buffer.from(parts[2]!, "hex")));
}
export async function createAccount(db: DatabaseSync, input: { email: unknown; password: unknown; displayName: unknown }): Promise<SqlRow> {
  const address = email(input.email), name = text(input.displayName, "이름", 100);
  const encoded = await passwordHash(input.password);
  if (one(db, "SELECT id FROM platform_accounts WHERE email=?", address)) throw new HttpError(409, "ACCOUNT", "계정을 생성할 수 없습니다. 기존 계정으로 로그인하거나 복구하세요.");
  const id = randomUUID();
  db.prepare("INSERT INTO platform_accounts VALUES(?,?,?,?,?)").run(id, address, encoded, name, now());
  audit(db, "account.register", id);
  return { id, email: address, displayName: name };
}
export async function bootstrapAdmin(db: DatabaseSync, project: string): Promise<void> {
  const address = process.env.PLATFORM_ADMIN_EMAIL, password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!address && !password) return;
  if (!address || !password) throw new Error("PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD must be configured together");
  let account = one(db, "SELECT id FROM platform_accounts WHERE email=?", email(address));
  if (!account) account = await createAccount(db, { email: address, password, displayName: "관리자" });
  db.prepare("INSERT INTO platform_memberships VALUES(?,?,'owner') ON CONFLICT(project_id,account_id) DO NOTHING").run(project, String(account.id));
}
function cookieToken(req: IncomingMessage, scope: string): string | undefined {
  const name = cookieName(scope);
  return String(req.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="))?.slice(name.length + 1);
}
function setCookie(res: ServerResponse, value: string, origin: string, scope: string, maxAge = 28800): void {
  res.setHeader("Set-Cookie", `${cookieName(scope)}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`);
}
export function session(db: DatabaseSync, req: IncomingMessage, res: ServerResponse, origin: string, localOwner: boolean, create = false, scope = "local"): Identity {
  const cookie = cookieToken(req, scope);
  const existing = cookie ? one(db, "SELECT * FROM platform_sessions WHERE token_hash=? AND expires_at>?", hash(cookie), Date.now()) : null;
  if (existing) return { accountId: existing.account_id ? String(existing.account_id) : null, csrf: String(existing.csrf), tokenHash: String(existing.token_hash), localOwner };
  if (!create) return { accountId: null, csrf: "", tokenHash: "", localOwner };
  const token = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
  db.prepare("DELETE FROM platform_sessions WHERE expires_at<?").run(Date.now());
  db.prepare("INSERT INTO platform_sessions VALUES(?,NULL,?,?)").run(hash(token), csrf, Date.now() + 28_800_000);
  setCookie(res, token, origin, scope);
  return { accountId: null, csrf, tokenHash: hash(token), localOwner };
}
export function checkCsrf(req: IncomingMessage, identity: Identity): void {
  const provided = String(req.headers["x-platform-csrf"] ?? req.headers["x-csrf-token"] ?? "");
  if (!identity.csrf || provided.length !== identity.csrf.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(identity.csrf))) throw new HttpError(403, "CSRF", "요청 인증을 새로 연결하세요.");
}
export async function login(db: DatabaseSync, req: IncomingMessage, res: ServerResponse, origin: string, input: { email: unknown; password: unknown }, scope = "local"): Promise<SqlRow> {
  const address = email(input.email), password = text(input.password, "비밀번호", 128);
  const account = one(db, "SELECT * FROM platform_accounts WHERE email=?", address);
  const [, salt, encoded] = String(account?.password_hash ?? `scrypt:${"0".repeat(32)}:${"0".repeat(128)}`).split(":");
  const derived = await derive(password, salt!);
  if (!account || !encoded || !timingSafeEqual(derived, Buffer.from(encoded, "hex"))) { audit(db, "account.login", "anonymous", "failed"); throw new HttpError(401, "LOGIN", "이메일 또는 비밀번호를 확인하세요."); }
  const old = cookieToken(req, scope);
  if (old) db.prepare("DELETE FROM platform_sessions WHERE token_hash=?").run(hash(old));
  const token = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO platform_sessions VALUES(?,?,?,?)").run(hash(token), String(account.id), csrf, Date.now() + 28_800_000);
  setCookie(res, token, origin, scope); audit(db, "account.login", String(account.id));
  return { account: { id: account.id, email: account.email, displayName: account.display_name }, csrf };
}
export function logout(db: DatabaseSync, identity: Identity, res: ServerResponse, origin: string, scope = "local"): void {
  db.prepare("DELETE FROM platform_sessions WHERE token_hash=?").run(identity.tokenHash);
  setCookie(res, "", origin, scope, 0);
  audit(db, "account.logout", identity.accountId ?? "anonymous");
}
export function role(db: DatabaseSync, identity: Identity, project: string): Role | null {
  if (identity.localOwner) return "owner";
  if (!identity.accountId) return null;
  const member = one(db, "SELECT role FROM platform_memberships WHERE project_id=? AND account_id=?", project, identity.accountId);
  return member ? String(member.role) as Role : "visitor";
}
export function authorize(db: DatabaseSync, identity: Identity, project: string, allowed: Role[]): void {
  const current = role(db, identity, project);
  if (!current || (!allowed.includes(current) && current !== "owner")) throw new HttpError(identity.accountId || identity.localOwner ? 403 : 401, "PERMISSION", "이 작업을 수행할 권한이 없습니다.");
}
export function requireAccount(identity: Identity): string {
  if (!identity.accountId) throw new HttpError(401, "LOGIN_REQUIRED", "로그인 후 이용하세요.");
  return identity.accountId;
}
export function accountInfo(db: DatabaseSync, identity: Identity): SqlRow | null {
  return identity.accountId ? one(db, "SELECT id,email,display_name AS displayName FROM platform_accounts WHERE id=?", identity.accountId) : null;
}
export function issueReset(db: DatabaseSync, address: unknown): { token: string; accountId: string } | null {
  const account = one(db, "SELECT id FROM platform_accounts WHERE email=?", email(address));
  if (!account) return null;
  const token = randomBytes(32).toString("hex");
  db.prepare("DELETE FROM platform_reset_tokens WHERE account_id=?").run(String(account.id));
  db.prepare("INSERT INTO platform_reset_tokens VALUES(?,?,?,NULL)").run(hash(token), String(account.id), Date.now() + 15 * 60_000);
  audit(db, "account.reset.request", String(account.id));
  return { token, accountId: String(account.id) };
}
export async function resetPassword(db: DatabaseSync, token: unknown, password: unknown): Promise<void> {
  const tokenHash = hash(text(token, "복구 토큰", 100));
  const encoded = await passwordHash(password);
  transaction(db, () => {
    const reset = one(db, "SELECT * FROM platform_reset_tokens WHERE token_hash=? AND expires_at>? AND used_at IS NULL", tokenHash, Date.now());
    if (!reset) throw new HttpError(400, "RESET", "복구 토큰이 만료되었거나 이미 사용되었습니다.");
    db.prepare("UPDATE platform_accounts SET password_hash=? WHERE id=?").run(encoded, String(reset.account_id));
    db.prepare("UPDATE platform_reset_tokens SET used_at=? WHERE token_hash=?").run(now(), tokenHash);
    db.prepare("DELETE FROM platform_sessions WHERE account_id=?").run(String(reset.account_id));
    audit(db, "account.reset.complete", String(reset.account_id));
  });
}
export function invite(db: DatabaseSync, project: string, address: unknown, requestedRole: unknown): SqlRow {
  const invitedRole = text(requestedRole, "역할", 20);
  if (!["editor", "reviewer", "operator", "visitor"].includes(invitedRole)) throw new HttpError(400, "ROLE", "초대 역할을 확인하세요.");
  const id = randomUUID(), token = randomBytes(32).toString("hex"), expires = Date.now() + 7 * 86400_000;
  db.prepare("INSERT INTO platform_invites VALUES(?,?,?,?,?,?,'pending',?)").run(id, project, email(address), invitedRole, hash(token), expires, now());
  audit(db, "invite.create", id);
  return { id, token, expiresAt: new Date(expires).toISOString(), role: invitedRole };
}
export function acceptInvite(db: DatabaseSync, identity: Identity, token: unknown): void {
  const account = requireAccount(identity);
  transaction(db, () => {
    const invitation = one(db, "SELECT * FROM platform_invites WHERE token_hash=? AND status='pending' AND expires_at>?", hash(text(token, "초대 토큰", 100)), Date.now());
    const address = one(db, "SELECT email FROM platform_accounts WHERE id=?", account)?.email;
    if (!invitation || invitation.email !== address) throw new HttpError(400, "INVITE", "초대가 만료되었거나 계정과 일치하지 않습니다.");
    db.prepare("INSERT INTO platform_memberships VALUES(?,?,?) ON CONFLICT(project_id,account_id) DO UPDATE SET role=excluded.role").run(String(invitation.project_id), account, String(invitation.role));
    db.prepare("UPDATE platform_invites SET status='accepted' WHERE id=?").run(String(invitation.id));
    audit(db, "invite.accept", String(invitation.id));
  });
}
export function accessList(db: DatabaseSync, project: string): { members: SqlRow[]; invites: SqlRow[] } {
  return { members: many(db, "SELECT a.id,a.email,a.display_name AS displayName,m.role FROM platform_memberships m JOIN platform_accounts a ON a.id=m.account_id WHERE m.project_id=?", project), invites: many(db, "SELECT id,email,role,status,expires_at AS expiresAt FROM platform_invites WHERE project_id=? ORDER BY created_at DESC LIMIT 100", project) };
}
