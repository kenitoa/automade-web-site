import { randomUUID } from "node:crypto";
import type { ExpansionScope, PackInstallation } from "../../src/domain/expansion";
import type { Project } from "../../src/domain/types";
import { createPackageBlock, parseDeclarativePackage, previewPackageUpdate, removePackage, verifyPackageIntegrity } from "../../src/domain/packages";
import { parseProject, record } from "../../src/domain/validation";
import { HttpError } from "../http";
import type { Store } from "../store";
import { audit, hash, integer, many, now, one, text, transaction } from "../platform/common";
import { CatalogService } from "../advancement/catalog";

export interface PackPreview { project: Project; changes: unknown[]; baseRevision: number; approvalFingerprint: string; mode: string; manifest: unknown }
export class PackService {
  constructor(readonly store: Store) {}
  list(scope: ExpansionScope): PackInstallation[] { return many(this.store.db, "SELECT * FROM expansion_pack_installations WHERE project_id=? AND organization_id=? ORDER BY updated_at DESC LIMIT 100", scope.projectId, scope.organizationId).map(row => ({ id: String(row.id), scope, packageId: String(row.package_id), version: String(row.version), integrity: String(row.integrity), installedRevision: Number(row.installed_revision), blockIds: JSON.parse(String(row.block_ids)) as string[], removed: Boolean(row.removed), createdAt: String(row.created_at), updatedAt: String(row.updated_at) })); }
  async preview(scope: ExpansionScope, actor: string, input: Record<string, unknown>): Promise<PackPreview> {
    const project = this.store.project(scope.projectId); if (!project || project.revision !== integer(input.baseRevision, "문서 버전")) throw new HttpError(409, "PACK_REVISION", "현재 문서 버전에서 패키지를 검토하세요.");
    const manifest = parseDeclarativePackage(input.manifest); await verifyPackageIntegrity(manifest);
    const mode = text(input.mode, "패키지 작업", 20); if (!["install", "upgrade", "remove", "pause"].includes(mode)) throw new HttpError(400, "PACK_MODE", "패키지 작업을 확인하세요.");
    if(['install','upgrade'].includes(mode))new CatalogService(this.store.db).assertInstall(manifest.id,manifest.version);
    let proposed: Project, changes: unknown[];
    if (mode === "remove") { proposed = removePackage(project, manifest.id, true); changes = project.blocks.filter(block => block.type === "extension" && block.props.extensionDefinitionId?.startsWith(manifest.id + "/")).map(block => ({ blockId: block.id, field: "type", before: "extension", after: proposed.blocks.find(item => item.id === block.id)?.type })); }
    else if (mode === "pause") { proposed = structuredClone(project); changes = []; for (const block of proposed.blocks) if (block.type === "extension" && block.props.extensionDefinitionId?.startsWith(manifest.id + "/") && !block.hidden) { block.hidden = true; changes.push({ blockId: block.id, field: "hidden", before: false, after: true }); } proposed.revision++; proposed.updatedAt = now(); }
    else if (mode === "upgrade") { const preview = previewPackageUpdate(project, manifest); proposed = preview.project; changes = preview.changes; }
    else {
      if (project.blockPackages?.some(item => item.id === manifest.id)) throw new HttpError(409, "PACK_INSTALLED", "이미 설치된 패키지는 업그레이드를 사용하세요.");
      proposed = structuredClone(project); proposed.blockPackages = [...proposed.blockPackages ?? [], manifest]; proposed.featurePins = [...proposed.featurePins ?? [], { packageId: manifest.id, version: manifest.version, integrity: manifest.integrity }];
      const pageId = input.pageId ? text(input.pageId, "페이지 ID", 100) : proposed.pages.find(page => page.home)!.id;
      if (!proposed.pages.some(page => page.id === pageId)) throw new HttpError(400, "PACK_PAGE", "페이지를 확인하세요.");
      const ids = input.definitionIds === undefined ? manifest.definitions.map(item => item.id) : input.definitionIds;
      if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => typeof id !== "string" || !manifest.definitions.some(item => item.id === id))) throw new HttpError(400, "PACK_DEFINITIONS", "설치할 패키지 블록을 확인하세요.");
      const blocks = ids.map(id => createPackageBlock(proposed, manifest.id, String(id), pageId)); proposed.blocks.push(...blocks); proposed.revision++; proposed.updatedAt = now(); changes = blocks.map(block => ({ blockId: block.id, field: "install", before: null, after: block.type }));
    }
    proposed.revision = project.revision + 1; proposed.updatedAt = now();
    proposed = parseProject(proposed); const approvalFingerprint = hash(JSON.stringify([scope, actor, project.revision, mode, manifest, proposed]));
    const result: PackPreview = { project: proposed, changes, baseRevision: project.revision, approvalFingerprint, mode, manifest };
    this.store.db.prepare("INSERT INTO runtime_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run("expansion:pack:" + approvalFingerprint, JSON.stringify({ ...result, actor, scope, expires: Date.now() + 900_000 })); return result;
  }
  async apply(scope: ExpansionScope, actor: string, fingerprint: unknown): Promise<Project> {
    const key = text(fingerprint, "검토 식별자", 64), stored = one(this.store.db, "SELECT value FROM runtime_state WHERE key=?", "expansion:pack:" + key);
    if (!stored) throw new HttpError(409, "PACK_PREVIEW", "패키지 변경을 먼저 검토하세요.");
    const preview = record(JSON.parse(String(stored.value))), proposedScope = record(preview.scope);
    if (preview.actor !== actor || proposedScope.projectId !== scope.projectId || proposedScope.organizationId !== scope.organizationId || Number(preview.expires) <= Date.now()) throw new HttpError(403, "PACK_PREVIEW", "검토 식별자의 권한 또는 만료를 확인하세요.");
    const manifest = parseDeclarativePackage(preview.manifest); await verifyPackageIntegrity(manifest);
    if(['install','upgrade'].includes(String(preview.mode)))new CatalogService(this.store.db).assertInstall(manifest.id,manifest.version);
    const project = parseProject(preview.project); this.store.save(project, Number(preview.baseRevision));
    transaction(this.store.db, () => {
      const old = one(this.store.db, "SELECT id,created_at FROM expansion_pack_installations WHERE project_id=? AND package_id=?", scope.projectId, manifest.id), id = old ? String(old.id) : randomUUID(), blockIds = project.blocks.filter(block => block.type === "extension" && block.props.extensionDefinitionId?.startsWith(manifest.id + "/")).map(block => block.id);
      this.store.db.prepare("INSERT INTO expansion_pack_installations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,package_id) DO UPDATE SET version=excluded.version,integrity=excluded.integrity,installed_revision=excluded.installed_revision,block_ids=excluded.block_ids,manifest=excluded.manifest,removed=excluded.removed,updated_at=excluded.updated_at").run(id, scope.organizationId, scope.workspaceId, scope.projectId, manifest.id, manifest.version, manifest.integrity, project.revision, JSON.stringify(blockIds), JSON.stringify(manifest), preview.mode === "remove" ? 1 : 0, old ? String(old.created_at) : now(), now());
      this.store.db.prepare("DELETE FROM runtime_state WHERE key=?").run("expansion:pack:" + key); audit(this.store.db, "pack." + String(preview.mode), manifest.id);
    }); return project;
  }
}
