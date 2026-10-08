import type { CmsManagementPage, CmsUpsertResult, ExpansionScope } from "../../src/domain/expansion";
import { editContentRecord, parseCmsQuery, validateCmsRecord } from "../../src/domain/cms";
import { parseProject, record } from "../../src/domain/validation";
import { HttpError } from "../http";
import type { Store } from "../store";
import { audit, hash, integer, now, text } from "../platform/common";
export class ContentService {
  constructor(readonly store: Store) {}
  query(scope: ExpansionScope, collectionId: string, params: URLSearchParams): CmsManagementPage {
    const project = this.store.project(scope.projectId), collection = project?.collections?.find(item => item.id === collectionId); if (!project || !collection) throw new HttpError(404, "COLLECTION", "컬렉션을 찾을 수 없습니다.");
    const query = parseCmsQuery(Object.fromEntries([...params].filter(([key]) => key !== "cursor"))), sort = query.sort.replace(/^-/, "");
    if (!["title", "publishedAt"].includes(sort) && !collection.schema?.some(field => field.id === sort)) throw new HttpError(400, "CMS_SORT", "정렬 필드를 확인하세요.");
    const records = collection.records.filter(item => !query.q || [item.title, item.body, ...Object.values(item.values ?? {})].join(" ").toLocaleLowerCase().includes(query.q.toLocaleLowerCase()));
    records.sort((a, b) => { const left = sort === "title" ? a.title : sort === "publishedAt" ? a.publishedAt : a.values?.[sort], right = sort === "title" ? b.title : sort === "publishedAt" ? b.publishedAt : b.values?.[sort]; return (typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? ""))) * (query.sort.startsWith("-") ? -1 : 1) || a.id.localeCompare(b.id); });
    const fingerprint = hash(JSON.stringify([scope.projectId, collectionId, project.revision, query.q, query.sort])); let position = 0;
    if (params.has("cursor")) { const token = text(params.get("cursor"), "조회 커서", 500); let cursor: Record<string, unknown>; try { cursor = record(JSON.parse(Buffer.from(token, "base64url").toString("utf8"))); } catch { throw new HttpError(400, "CMS_CURSOR", "조회 커서를 확인하세요."); } if (cursor.fingerprint !== fingerprint || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0 || Number(cursor.offset) > records.length) throw new HttpError(409, "CMS_CURSOR_STALE", "조회 조건 또는 문서가 변경되었습니다. 처음부터 조회하세요."); position = Number(cursor.offset); }
    const page = records.slice(position, position + query.limit); return { records: page, nextCursor: position + page.length < records.length ? Buffer.from(JSON.stringify({ fingerprint, offset: position + page.length })).toString("base64url") : null, total: records.length, schemaRevision: collection.schemaRevision ?? 0, projectRevision: project.revision };
  }
  upsert(scope: ExpansionScope, collectionId: string, input: Record<string, unknown>): CmsUpsertResult {
    const project = this.store.project(scope.projectId), collection = project?.collections?.find(item => item.id === collectionId); if (!project || !collection) throw new HttpError(404, "COLLECTION", "컬렉션을 찾을 수 없습니다.");
    if (project.revision !== integer(input.baseRevision, "문서 버전")) throw new HttpError(409, "CMS_CONFLICT", "문서가 변경되었습니다.");
    const proposed = record(input.record), previous = collection.records.find(item => item.id === proposed.id);
    const candidate = previous ? editContentRecord(previous, { ...proposed, id: previous.id } as Parameters<typeof editContentRecord>[1]) : { ...proposed, contentRevision: 0, status: "draft", workflow: { state: "draft" } };
    const updated = parseProject({ ...project, revision: project.revision + 1, updatedAt: now(), collections: project.collections!.map(item => item.id === collectionId ? { ...item, records: previous ? item.records.map(item => item.id === previous.id ? candidate : item) : [...item.records, candidate] } : item) });
    const changedCollection = updated.collections!.find(item => item.id === collectionId)!, changed = changedCollection.records.find(item => item.id === proposed.id)!;
    const errors = validateCmsRecord(updated, changedCollection, changed, previous); if (errors.length) throw new HttpError(400, "CMS_VALUES", errors.join(" "));
    this.store.save(updated, project.revision); audit(this.store.db, "cms.record.upsert", changed.id); return { project: updated, record: changed };
  }
}
