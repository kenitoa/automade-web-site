import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ExpansionBrand, ExpansionLibraryItem } from "../../src/domain/expansion";
import type { Project, SharedComponent } from "../../src/domain/types";
import { createProject } from "../../src/domain/catalog";
import { parseDeclarativePackage } from "../../src/domain/packages";
import { parseProject } from "../../src/domain/validation";
import { HttpError } from "../http";
import { audit, integer, many, now, one, text, transaction, type SqlRow } from "../platform/common";

const brand = (row: SqlRow): ExpansionBrand => ({ id: String(row.id), organizationId: String(row.organization_id), name: String(row.name), revision: Number(row.revision), theme: JSON.parse(String(row.body)) as Record<string, unknown>, updatedAt: String(row.updated_at) });
const item = (row: SqlRow): ExpansionLibraryItem => ({ id: String(row.id), organizationId: String(row.organization_id), kind: String(row.kind) as ExpansionLibraryItem["kind"], name: String(row.name), revision: Number(row.revision), body: JSON.parse(String(row.body)) as unknown, updatedAt: String(row.updated_at) });
export function validateLibrary(kind: string, value: unknown): unknown {
  const base = createProject();
  if (kind === "theme") return parseProject({ ...base, theme: value }).theme;
  if (kind === "component") return parseProject({ ...base, components: [value] }).components![0]!;
  if (kind === "pack") return parseDeclarativePackage(value);
  throw new HttpError(400, "LIBRARY_KIND", "라이브러리 종류를 확인하세요.");
}
export class LibraryService {
  constructor(readonly db: DatabaseSync) {}
  private brand(row: SqlRow): ExpansionBrand { const published = one(this.db, "SELECT value FROM runtime_state WHERE key=?", "expansion:brand-published:" + String(row.id)), state: unknown = published ? JSON.parse(String(published.value)) : null, revision = state && typeof state === "object" ? (state as Record<string, unknown>).revision : null; return { ...brand(row), publishedRevision: typeof revision === "number" && Number.isSafeInteger(revision) ? revision : undefined }; }
  brands(organizationId: string): ExpansionBrand[] { return many(this.db, "SELECT * FROM expansion_brands WHERE organization_id=? ORDER BY updated_at DESC LIMIT 500", organizationId).map(row => this.brand(row)); }
  saveBrand(organizationId: string, input: Record<string, unknown>, id?: string): ExpansionBrand {
    const name = text(input.name, "브랜드 이름", 100), theme = validateLibrary("theme", input.theme), key = id ?? randomUUID();
    transaction(this.db, () => {
      const previous = one(this.db, "SELECT * FROM expansion_brands WHERE id=? AND organization_id=?", key, organizationId);
      if (id && !previous) throw new HttpError(404, "BRAND", "브랜드를 찾을 수 없습니다.");
      if (previous && Number(previous.revision) !== integer(input.baseRevision, "브랜드 버전", 1)) throw new HttpError(409, "LIBRARY_CONFLICT", "브랜드가 변경되었습니다.");
      const revision = Number(previous?.revision ?? 0) + 1, body = JSON.stringify(theme), time = now();
      this.db.prepare("INSERT INTO expansion_brands VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,revision=excluded.revision,body=excluded.body,updated_at=excluded.updated_at").run(key, organizationId, name, revision, body, time);
      this.db.prepare("INSERT INTO expansion_brand_versions VALUES(?,?,?,?)").run(key, revision, body, time); audit(this.db, "brand.save", key);
    }); return this.brand(one(this.db, "SELECT * FROM expansion_brands WHERE id=?", key)!);
  }
  items(organizationId: string): ExpansionLibraryItem[] { return many(this.db, "SELECT * FROM expansion_library_items WHERE organization_id=? ORDER BY updated_at DESC LIMIT 500", organizationId).map(item); }
  saveItem(organizationId: string, input: Record<string, unknown>, id?: string): ExpansionLibraryItem {
    const kind = text(input.kind, "라이브러리 종류", 20), name = text(input.name, "이름", 100), value = validateLibrary(kind, input.body), key = id ?? randomUUID();
    transaction(this.db, () => {
      const previous = one(this.db, "SELECT * FROM expansion_library_items WHERE id=? AND organization_id=?", key, organizationId);
      if (id && !previous) throw new HttpError(404, "LIBRARY", "라이브러리를 찾을 수 없습니다.");
      if (previous && (previous.kind !== kind || Number(previous.revision) !== integer(input.baseRevision, "버전", 1))) throw new HttpError(409, "LIBRARY_CONFLICT", "라이브러리가 변경되었습니다.");
      const revision = Number(previous?.revision ?? 0) + 1, body = JSON.stringify(value), time = now();
      this.db.prepare("INSERT INTO expansion_library_items VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,revision=excluded.revision,body=excluded.body,updated_at=excluded.updated_at").run(key, organizationId, kind, name, revision, body, time);
      this.db.prepare("INSERT INTO expansion_library_versions VALUES(?,?,?,?)").run(key, revision, body, time); audit(this.db, "library.save", key);
    }); return item(one(this.db, "SELECT * FROM expansion_library_items WHERE id=?", key)!);
  }
  component(id: string, organizationId: string): SharedComponent { const row = one(this.db, "SELECT body FROM expansion_library_items WHERE id=? AND organization_id=? AND kind='component'", id, organizationId); if (!row) throw new HttpError(404, "LIBRARY", "컴포넌트를 찾을 수 없습니다."); return validateLibrary("component", JSON.parse(String(row.body))) as SharedComponent; }
  theme(id: string, organizationId: string): Project["theme"] { const row = one(this.db, "SELECT body FROM expansion_brands WHERE id=? AND organization_id=?", id, organizationId); if (!row) throw new HttpError(404, "BRAND", "브랜드를 찾을 수 없습니다."); return validateLibrary("theme", JSON.parse(String(row.body))) as Project["theme"]; }
}
