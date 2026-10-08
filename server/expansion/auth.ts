import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { CreatorAccount, CreatorIdentity, CreatorSession } from "../../src/domain/expansion";
import { HttpError } from "../http";
import { email, passwordHash, verifyPasswordHash } from "../platform/auth";
import { audit, hash, now, one, text, transaction, type SqlRow } from "../platform/common";

const COOKIE = "automade-creator";
function token(req: IncomingMessage): string | null {
  const value = String(req.headers.cookie ?? "").split(";").map(value => value.trim()).find(value => value.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
function account(row: SqlRow): CreatorAccount { return { id: String(row.id), email: String(row.email), displayName: String(row.display_name) }; }
export class CreatorAuth {
  constructor(readonly db: DatabaseSync) {}
  private cookie(res: ServerResponse, value: string, origin: string, maxAge = 28800): void {
    res.setHeader("Set-Cookie", `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`);
  }
  private row(req: IncomingMessage): SqlRow | null {
    const value = token(req);
    return value ? one(this.db, "SELECT s.*,a.disabled FROM creator_sessions s LEFT JOIN creator_accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>?", hash(value), Date.now()) : null;
  }
  authenticate(req: IncomingMessage): CreatorIdentity | null {
    const row = this.row(req);
    return row?.account_id && !row.disabled ? { id: String(row.account_id), csrf: String(row.csrf), sessionId: String(row.token_hash) } : null;
  }
  session(req: IncomingMessage, res: ServerResponse, origin: string, localOwner: boolean): CreatorSession {
    let row = this.row(req);
    if (row?.disabled) { this.db.prepare("DELETE FROM creator_sessions WHERE token_hash=?").run(String(row.token_hash)); row = null; }
    if (!row) {
      const value = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
      this.db.prepare("DELETE FROM creator_sessions WHERE expires_at<=?").run(Date.now());
      this.db.prepare("INSERT INTO creator_sessions VALUES(?,NULL,?,?)").run(hash(value), csrf, Date.now() + 28_800_000);
      this.cookie(res, value, origin); row = { csrf, account_id: null };
    }
    const current = row.account_id ? one(this.db, "SELECT * FROM creator_accounts WHERE id=? AND disabled=0", String(row.account_id)) : null;
    return { account: current ? account(current) : null, csrf: String(row.csrf), localOwner };
  }
  csrf(req: IncomingMessage): void {
    const row = this.row(req), supplied = String(req.headers["x-creator-csrf"] ?? req.headers["x-csrf-token"] ?? "");
    const expected = String(row?.csrf ?? "");
    if (!expected || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new HttpError(403, "CSRF", "요청 인증을 새로 연결하세요.");
  }
  rate(req: IncomingMessage, operation: string): void {
    const bucket = hash(`${operation}:${req.socket.remoteAddress ?? "unknown"}`), clock = Date.now();
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM creator_auth_limits WHERE reset_at<=?").run(clock);
      const row = one(this.db, "SELECT count FROM creator_auth_limits WHERE bucket=?", bucket);
      if (Number(row?.count ?? 0) >= 20) throw new HttpError(429, "AUTH_LIMIT", "잠시 후 다시 시도하세요.");
      this.db.prepare("INSERT INTO creator_auth_limits VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1").run(bucket, clock + 300_000);
    });
  }
  async create(input: Record<string, unknown>): Promise<CreatorAccount> {
    const address = email(input.email), displayName = text(input.displayName, "이름", 100), encoded = await passwordHash(input.password);
    if (one(this.db, "SELECT id FROM creator_accounts WHERE email=?", address)) throw new HttpError(409, "ACCOUNT", "계정을 생성할 수 없습니다. 로그인 또는 복구를 이용하세요.");
    const id = randomUUID();
    transaction(this.db, () => {
      const invite = input.inviteToken ? one(this.db, "SELECT * FROM expansion_invites WHERE token_hash=? AND status='pending' AND expires_at>?", hash(text(input.inviteToken, "제작자 초대", 100)), Date.now()) : null;
      if (input.inviteToken && (!invite || invite.email !== address)) throw new HttpError(400, "INVITE", "사용할 수 없는 제작자 초대입니다.");
      this.db.prepare("INSERT INTO creator_accounts VALUES(?,?,?,?,0,?)").run(id, address, encoded, displayName, now());
      if (invite) { this.db.prepare("INSERT INTO expansion_memberships VALUES(?,?,?)").run(String(invite.organization_id), id, String(invite.role)); if (invite.workspace_id) this.db.prepare("INSERT INTO expansion_workspace_grants VALUES(?,?,?)").run(String(invite.workspace_id), id, String(invite.capabilities)); this.db.prepare("UPDATE expansion_invites SET status='accepted' WHERE id=?").run(String(invite.id)); audit(this.db, "organization.invite.accept", String(invite.id)); }
      audit(this.db, "creator.register", id);
    }); return { id, email: address, displayName };
  }
  async bootstrap(): Promise<void> {
    const address = process.env.STUDIO_ADMIN_EMAIL, password = process.env.STUDIO_ADMIN_PASSWORD;
    if (!address && !password) return;
    if (!address || !password) throw new Error("STUDIO_ADMIN_EMAIL and STUDIO_ADMIN_PASSWORD must be configured together");
    let current = one(this.db, "SELECT * FROM creator_accounts WHERE email=?", email(address));
    if (!current) { const created = await this.create({ email: address, password, displayName: "제작 관리자" }); current = { id: created.id }; }
    if (current.disabled) throw new Error("Configured studio administrator is disabled");
    this.db.prepare("INSERT INTO expansion_memberships VALUES('local',?,'owner') ON CONFLICT DO NOTHING").run(String(current.id));
  }
  async login(req: IncomingMessage, res: ServerResponse, origin: string, input: Record<string, unknown>): Promise<CreatorSession> {
    const current = one(this.db, "SELECT * FROM creator_accounts WHERE email=?", email(input.email));
    const valid = await verifyPasswordHash(text(input.password, "비밀번호", 128), current ? String(current.password_hash) : null);
    if (!current || current.disabled || !valid) { audit(this.db, "creator.login", "anonymous", "failed"); throw new HttpError(401, "LOGIN", "이메일 또는 비밀번호를 확인하세요."); }
    const previous = token(req), value = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
    transaction(this.db, () => {
      if (previous) this.db.prepare("DELETE FROM creator_sessions WHERE token_hash=?").run(hash(previous));
      this.db.prepare("INSERT INTO creator_sessions VALUES(?,?,?,?)").run(hash(value), String(current.id), csrf, Date.now() + 28_800_000);
      audit(this.db, "creator.login", String(current.id));
    });
    this.cookie(res, value, origin); return { account: account(current), csrf, localOwner: false };
  }
  logout(req: IncomingMessage, res: ServerResponse, origin: string): void {
    const previous = token(req); if (previous) this.db.prepare("DELETE FROM creator_sessions WHERE token_hash=?").run(hash(previous));
    this.cookie(res, "", origin, 0);
  }
  requestReset(address: unknown): string | null {
    const current = one(this.db, "SELECT id FROM creator_accounts WHERE email=? AND disabled=0", email(address));
    if (!current) return null;
    const value = randomBytes(32).toString("hex");
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM creator_reset_tokens WHERE account_id=?").run(String(current.id));
      this.db.prepare("INSERT INTO creator_reset_tokens VALUES(?,?,?,NULL)").run(hash(value), String(current.id), Date.now() + 900_000);
      audit(this.db, "creator.reset.request", String(current.id));
    }); return value;
  }
  async reset(input: Record<string, unknown>): Promise<void> {
    const encoded = await passwordHash(input.password), fingerprint = hash(text(input.token, "복구 토큰", 100));
    transaction(this.db, () => {
      const row = one(this.db, "SELECT * FROM creator_reset_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?", fingerprint, Date.now());
      if (!row) throw new HttpError(400, "RESET_TOKEN", "복구 토큰이 만료되었거나 사용되었습니다.");
      this.db.prepare("UPDATE creator_reset_tokens SET used_at=? WHERE token_hash=?").run(now(), fingerprint);
      this.db.prepare("UPDATE creator_accounts SET password_hash=? WHERE id=?").run(encoded, String(row.account_id));
      this.db.prepare("DELETE FROM creator_sessions WHERE account_id=?").run(String(row.account_id));
      audit(this.db, "creator.reset.confirm", String(row.account_id));
    });
  }
}
