import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
export interface OwnerSession { csrf: string; expires: number }
const hash = (token: string): string => createHash("sha256").update(token).digest("hex");
export class StudioSessions {
  constructor(readonly db: DatabaseSync, readonly now: () => number = Date.now) {}
  get(token: string | undefined): OwnerSession | null {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const row = this.db.prepare("SELECT csrf,expires_at FROM studio_owner_sessions WHERE token_hash=? AND expires_at>?").get(hash(token), this.now());
    return row ? { csrf: String(row.csrf), expires: Number(row.expires_at) } : null;
  }
  create(): OwnerSession & { token: string } {
    const token = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex"), expires = this.now() + 8 * 60 * 60 * 1000;
    this.db.prepare("DELETE FROM studio_owner_sessions WHERE expires_at<=?").run(this.now());
    this.db.prepare("INSERT INTO studio_owner_sessions VALUES(?,?,?)").run(hash(token), csrf, expires);
    return { token, csrf, expires };
  }
  revoke(token: string): void { this.db.prepare("DELETE FROM studio_owner_sessions WHERE token_hash=?").run(hash(token)); }
}
