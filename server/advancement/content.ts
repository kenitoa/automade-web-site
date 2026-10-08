import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type {
  ContentCollection,
  ContentRecord,
  Project,
} from "../../src/domain/types";
import type {
  ContentContext,
  ContentMigrationPlan,
  ContentPage,
  ContentQueryOptions,
  ContentRecordResult,
  ContentTransition,
  ContentUpsert,
  TranslationReview,
} from "../../src/domain/contentContracts";
import {
  contentSourceFields,
  publicationRecord,
  translationFieldsChanged,
} from "../../src/domain/contentState";
import {
  parseCmsQuery,
  parseCmsSchema,
  publicContentRecord,
  transitionContent,
  validateCmsRecord,
  isRecordPublished,
} from "../../src/domain/cms";
import {
  parseProject,
  record,
  ValidationError,
} from "../../src/domain/validation";
import {
  localizeProject,
  localizedPath,
  siteLanguages,
} from "../../src/domain/localization";
import { CONTENT_MIGRATION } from "./contentSchema";
import { HttpError } from "../http";
import { blockReferences } from "../../src/domain/blockRegistry";
export { CONTENT_MIGRATION } from "./contentSchema";

const now = (): string => new Date().toISOString();
const initializedDatabases = new WeakSet<DatabaseSync>();
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const integer = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new HttpError(400, "CONTENT_REVISION", "콘텐츠 버전을 확인하세요.");
  return Number(value);
};
const key = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value))
    throw new HttpError(400, "CONTENT_ID", "콘텐츠 ID를 확인하세요.");
  return value;
};
const json = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const mutable = (value: ContentRecord): ContentRecord => {
  const result = structuredClone(value);
  delete result.publication;
  delete result.translationReviews;
  delete result.fieldRevisions;
  delete result.languageRevisions;
  return result;
};
const authored = (value: ContentRecord): unknown => {
  const {
    workflow: _workflow,
    status: _status,
    publishedAt: _publishedAt,
    contentRevision: _contentRevision,
    addressHistory: _addressHistory,
    ...result
  } = mutable(value);
  return result;
};
function transformSchemaValues(
  record: ContentRecord,
  schema: NonNullable<ContentCollection["schema"]>,
): { record: ContentRecord; changes: number } {
  const item = structuredClone(record),
    allowed = new Set(schema.map((field) => field.id));
  let changes = 0;
  for (const [id, value] of Object.entries(item.values ?? {}))
    if (!allowed.has(id)) {
      item.archivedValues ??= {};
      item.archivedValues[id] = value;
      delete item.values![id];
      changes++;
    }
  for (const [id, value] of Object.entries(item.archivedValues ?? {}))
    if (allowed.has(id) && item.values?.[id] === undefined) {
      item.values ??= {};
      item.values[id] = value;
      delete item.archivedValues![id];
      changes++;
    }
  return { record: item, changes };
}
interface StoredRecord {
  project_id: string;
  collection_id: string;
  record_id: string;
  revision: number;
  body: string;
  published_revision: number | null;
  field_revisions: string;
  language_revisions: string;
  translation_reviews: string;
  submitted_by: string | null;
  approved_by: string | null;
  approval_hash: string | null;
}
interface StoredCollection {
  body: string;
  revision: number;
  schema_revision: number;
}
interface StoredPublication {
  body: string;
  revision: number;
  sequence: number;
  schema_body: string;
  schema_revision: number;
  published_at: string;
}

/** Every mutation can safely nest inside Store.save's existing transaction. */
function atomic<T>(db: DatabaseSync, operation: () => T): T {
  const name = `content_${randomUUID().replaceAll("-", "")}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = operation();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw error;
  }
}

export class IndexedContentService {
  constructor(
    readonly db: DatabaseSync,
    readonly rawProject: (id: string) => Project | null,
  ) {
    if (!initializedDatabases.has(db)) {
      db.exec(CONTENT_MIGRATION);
      initializedDatabases.add(db);
    }
  }
  private project(id: string): Project {
    const project = this.rawProject(id);
    if (!project)
      throw new HttpError(
        404,
        "PROJECT_NOT_FOUND",
        "프로젝트를 찾을 수 없습니다.",
      );
    this.ensureLegacy(project);
    return project;
  }
  private collection(
    projectId: string,
    id: string,
    project?: Project,
  ): { source: ContentCollection; row: StoredCollection } {
    if (!project) this.project(projectId);
    const row = this.db
      .prepare(
        "SELECT body,revision,schema_revision FROM advancement_content_collections WHERE project_id=? AND collection_id=?",
      )
      .get(projectId, id) as unknown as StoredCollection | undefined;
    if (!row)
      throw new HttpError(
        404,
        "COLLECTION_NOT_FOUND",
        "컬렉션을 찾을 수 없습니다.",
      );
    return { source: json<ContentCollection>(row.body), row };
  }
  private stored(
    projectId: string,
    collectionId: string,
    recordId: string,
  ): StoredRecord | undefined {
    return this.db
      .prepare(
        "SELECT * FROM advancement_content_records WHERE project_id=? AND collection_id=? AND record_id=?",
      )
      .get(projectId, collectionId, recordId) as unknown as
      StoredRecord | undefined;
  }
  private published(
    projectId: string,
    collectionId: string,
    recordId: string,
  ): StoredPublication | undefined {
    return this.db
      .prepare(
        "SELECT p.* FROM advancement_content_live l JOIN advancement_content_publications p USING(project_id,collection_id,record_id,revision) WHERE l.project_id=? AND l.collection_id=? AND l.record_id=?",
      )
      .get(projectId, collectionId, recordId) as unknown as
      StoredPublication | undefined;
  }
  private result(row: StoredRecord): ContentRecordResult {
    const item = json<ContentRecord>(row.body),
      publication = this.published(
        row.project_id,
        row.collection_id,
        row.record_id,
      ),
      fieldRevisions = json<Record<string, number>>(row.field_revisions),
      languageRevisions = json<Record<string, number>>(row.language_revisions),
      translations = json<Record<string, TranslationReview>>(
        row.translation_reviews,
      );
    item.fieldRevisions = fieldRevisions;
    item.languageRevisions = languageRevisions;
    item.translationReviews = translations;
    if (publication)
      item.publication = {
        revision: publication.revision,
        sequence: publication.sequence,
        publishedAt: publication.published_at,
        schemaRevision: publication.schema_revision,
        schema: json(publication.schema_body),
        record: json(publication.body),
      };
    else delete item.publication;
    const addresses = this.db
      .prepare(
        "SELECT path,language,sequence FROM advancement_content_addresses WHERE project_id=? AND collection_id=? AND record_id=? AND active=0 ORDER BY sequence,path",
      )
      .all(row.project_id, row.collection_id, row.record_id)
      .map((entry) => ({
        path: String(entry.path),
        language: String(entry.language),
        sequence: Number(entry.sequence),
      }));
    if (addresses.length) {
      item.addressHistory = addresses;
      if (item.publication) item.publication.record.addressHistory = addresses;
    }
    return {
      record: item,
      recordRevision: row.revision,
      publishedRevision: publication?.revision ?? null,
      publicationSequence: publication?.sequence ?? 0,
      fieldRevisions,
      languageRevisions,
      translations,
    };
  }
  private bump(projectId: string, collectionId: string): void {
    this.db
      .prepare(
        "UPDATE advancement_content_collections SET revision=revision+1 WHERE project_id=? AND collection_id=?",
      )
      .run(projectId, collectionId);
  }
  private indexes(
    projectId: string,
    collection: ContentCollection,
    item: ContentRecord,
    view: "draft" | "published",
  ): void {
    this.db
      .prepare(
        "DELETE FROM advancement_content_values WHERE project_id=? AND collection_id=? AND record_id=? AND view=?",
      )
      .run(projectId, collection.id, item.id, view);
    const insert = this.db.prepare(
      "INSERT INTO advancement_content_values(project_id,collection_id,record_id,view,language,field_id,type,text_value,numeric_value,public) VALUES(?,?,?,?,?,?,?,?,?,?)",
    );
    for (const field of collection.schema ?? [])
      for (const language of ["", ...Object.keys(item.translations ?? {})]) {
        const input =
          language && field.localized
            ? (item.translations?.[language]?.values?.[field.id] ??
              item.values?.[field.id])
            : item.values?.[field.id];
        if (input !== undefined && input !== null)
          insert.run(
            projectId,
            collection.id,
            item.id,
            view,
            language,
            field.id,
            field.type,
            typeof input === "string" ? input : JSON.stringify(input),
            typeof input === "number" ? input : null,
            field.public ? 1 : 0,
          );
      }
  }
  private save(
    projectId: string,
    collection: ContentCollection,
    item: ContentRecord,
    actorId: string,
    previous?: StoredRecord,
    submittedBy: string | null = null,
    approvedBy: string | null = null,
    approvalHash: string | null = null,
  ): void {
    const body = mutable(item),
      revision = body.contentRevision ?? 0;
    const fieldRevisions = previous
        ? json<Record<string, number>>(previous.field_revisions)
        : {},
      languageRevisions = previous
        ? json<Record<string, number>>(previous.language_revisions)
        : {},
      reviews = previous
        ? json<Record<string, TranslationReview>>(previous.translation_reviews)
        : {};
    const changed = previous
      ? translationFieldsChanged(json(previous.body), body)
      : Object.keys(contentSourceFields(body));
    for (const path of changed) fieldRevisions[path] = revision;
    if (previous) {
      const old = json<ContentRecord>(previous.body);
      for (const language of new Set([
        ...Object.keys(old.translations ?? {}),
        ...Object.keys(body.translations ?? {}),
      ]))
        if (
          hash(old.translations?.[language] ?? null) !==
          hash(body.translations?.[language] ?? null)
        )
          languageRevisions[language] = revision;
    }
    for (const review of Object.values(reviews)) {
      const affected = changed.filter((path) =>
        Object.hasOwn(review.sourceFieldHashes, path),
      );
      if (affected.length) {
        review.changedFields = [
          ...new Set([...review.changedFields, ...affected]),
        ];
        review.state = "stale";
      }
    }
    const search = [body.title, body.body, ...Object.values(body.values ?? {})]
      .join(" ")
      .toLowerCase();
    this.db
      .prepare(
        "INSERT INTO advancement_content_records(project_id,collection_id,record_id,revision,body,title,slug,category,search_text,workflow,published_revision,field_revisions,language_revisions,translation_reviews,submitted_by,approved_by,approval_hash,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,collection_id,record_id) DO UPDATE SET revision=excluded.revision,body=excluded.body,title=excluded.title,slug=excluded.slug,category=excluded.category,search_text=excluded.search_text,workflow=excluded.workflow,field_revisions=excluded.field_revisions,language_revisions=excluded.language_revisions,translation_reviews=excluded.translation_reviews,submitted_by=excluded.submitted_by,approved_by=excluded.approved_by,approval_hash=excluded.approval_hash,updated_at=excluded.updated_at",
      )
      .run(
        projectId,
        collection.id,
        body.id,
        revision,
        JSON.stringify(body),
        body.title,
        body.slug,
        body.category,
        search,
        body.workflow?.state ?? body.status,
        previous?.published_revision ?? null,
        JSON.stringify(fieldRevisions),
        JSON.stringify(languageRevisions),
        JSON.stringify(reviews),
        submittedBy,
        approvedBy,
        approvalHash,
        now(),
      );
    this.db
      .prepare(
        "INSERT OR IGNORE INTO advancement_content_revisions(project_id,collection_id,record_id,revision,body,schema_revision,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        projectId,
        collection.id,
        body.id,
        revision,
        JSON.stringify(body),
        collection.schemaRevision ?? 0,
        actorId,
        now(),
      );
    this.indexes(projectId, collection, body, "draft");
    this.bump(projectId, collection.id);
    this.recordReferences(projectId, collection, body);
  }
  private recordReferences(
    projectId: string,
    collection: ContentCollection,
    item: ContentRecord,
  ): void {
    this.db
      .prepare(
        "DELETE FROM advancement_content_reference_edges WHERE project_id=? AND source_type='record' AND source_id=?",
      )
      .run(projectId, `${collection.id}/${item.id}`);
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO advancement_content_reference_edges VALUES(?,?,?,?,?,?,?)",
    );
    if (item.imageId)
      insert.run(
        projectId,
        "record",
        `${collection.id}/${item.id}`,
        "asset",
        item.imageId,
        "imageId",
        item.contentRevision ?? 0,
      );
    for (const field of collection.schema ?? []) {
      const value = item.values?.[field.id];
      if (field.type === "reference")
        for (const id of Array.isArray(value)
          ? value
          : typeof value === "string"
            ? [value]
            : [])
          insert.run(
            projectId,
            "record",
            `${collection.id}/${item.id}`,
            "record",
            `${field.referenceCollectionId}/${id}`,
            `values.${field.id}`,
            item.contentRevision ?? 0,
          );
      if (field.type === "image" && typeof value === "string")
        insert.run(
          projectId,
          "record",
          `${collection.id}/${item.id}`,
          "asset",
          value,
          `values.${field.id}`,
          item.contentRevision ?? 0,
        );
    }
  }
  private publicBody(
    projectId: string,
    collection: ContentCollection,
    item: ContentRecord,
  ): ContentRecord {
    const project = this.rawProject(projectId)!;
    const visibleProject = this.snapshotReferences(project, [item]);
    return publicContentRecord(collection, item, visibleProject, true);
  }
  private publish(
    projectId: string,
    collection: ContentCollection,
    item: ContentRecord,
    sequence: number,
  ): void {
    const body = mutable(item);
    body.status = "published";
    body.workflow = {
      state: "published",
      approvedRevision: body.contentRevision ?? 0,
    };
    body.publishedAt ||= now();
    const existing = this.db
      .prepare(
        "SELECT body FROM advancement_content_publications WHERE project_id=? AND collection_id=? AND record_id=? AND revision=?",
      )
      .get(projectId, collection.id, body.id, body.contentRevision ?? 0);
    if (existing && hash(json(existing.body)) !== hash(body))
      throw new HttpError(
        409,
        "IMMUTABLE_PUBLICATION",
        "이미 발행된 버전은 변경할 수 없습니다.",
      );
    this.db
      .prepare(
        "INSERT OR IGNORE INTO advancement_content_publications VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        projectId,
        collection.id,
        body.id,
        body.contentRevision ?? 0,
        sequence,
        JSON.stringify(body),
        JSON.stringify(collection.schema ?? []),
        collection.schemaRevision ?? 0,
        body.publishedAt,
      );
    const safe = this.publicBody(projectId, collection, body),
      search = [
        safe.title,
        safe.body,
        ...Object.values(safe.values ?? {}),
        ...Object.values(safe.translations ?? {}).flatMap((t) => [
          t?.title ?? "",
          t?.body ?? "",
          ...Object.values(t?.values ?? {}),
        ]),
      ]
        .join(" ")
        .toLowerCase();
    this.db
      .prepare(
        "INSERT INTO advancement_content_live VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,collection_id,record_id) DO UPDATE SET revision=excluded.revision,sequence=excluded.sequence,title=excluded.title,slug=excluded.slug,category=excluded.category,search_text=excluded.search_text,published_at=excluded.published_at",
      )
      .run(
        projectId,
        collection.id,
        body.id,
        body.contentRevision ?? 0,
        sequence,
        body.title,
        body.slug,
        body.category,
        search,
        body.publishedAt,
      );
    this.db
      .prepare(
        "UPDATE advancement_content_records SET published_revision=? WHERE project_id=? AND collection_id=? AND record_id=?",
      )
      .run(body.contentRevision ?? 0, projectId, collection.id, body.id);
    this.indexes(projectId, collection, safe, "published");
    this.addresses(projectId, collection, body, sequence);
  }
  private addresses(
    projectId: string,
    collection: ContentCollection,
    item: ContentRecord,
    sequence: number,
  ): void {
    const project = this.rawProject(projectId)!;
    this.db
      .prepare(
        "UPDATE advancement_content_addresses SET active=0 WHERE project_id=? AND collection_id=? AND record_id=?",
      )
      .run(projectId, collection.id, item.id);
    for (const language of siteLanguages(project)) {
      const path = localizedPath(
        project,
        `${collection.path === "/" ? "" : collection.path}/${item.localizedSlugs?.[language] ?? item.slug}`,
        language,
      );
      const existing = this.db
        .prepare(
          "SELECT collection_id,record_id FROM advancement_content_addresses WHERE project_id=? AND path=? AND language=?",
        )
        .get(projectId, path, language);
      if (
        (existing &&
          (existing.collection_id !== collection.id ||
            existing.record_id !== item.id)) ||
        project.pages.some(
          (page) =>
            localizedPath(project, page.path, language) === path ||
            page.aliases?.some(
              (alias) => localizedPath(project, alias, language) === path,
            ),
        )
      )
        throw new HttpError(
          409,
          "CONTENT_ADDRESS_CONFLICT",
          "다른 콘텐츠 또는 페이지가 사용하는 주소입니다.",
        );
      this.db
        .prepare(
          "INSERT INTO advancement_content_addresses VALUES(?,?,?,?,?,?,1) ON CONFLICT(project_id,path,language) DO UPDATE SET sequence=excluded.sequence,active=1",
        )
        .run(projectId, path, language, collection.id, item.id, sequence);
    }
  }
  ensureLegacy(project: Project): void {
    if (
      this.db
        .prepare(
          "SELECT 1 FROM advancement_content_projects WHERE project_id=?",
        )
        .get(project.id)
    )
      return;
    atomic(this.db, () => {
      this.db
        .prepare("INSERT INTO advancement_content_projects VALUES(?,0,?,?)")
        .run(project.id, hash(project.collections ?? []), now());
      for (const collection of project.collections ?? []) {
        this.db
          .prepare(
            "INSERT INTO advancement_content_collections VALUES(?,?,?,?,?)",
          )
          .run(
            project.id,
            collection.id,
            JSON.stringify({ ...collection, records: [] }),
            0,
            collection.schemaRevision ?? 0,
          );
        for (const original of collection.records) {
          const item = mutable(original);
          item.contentRevision ??= 0;
          let submitted: string | null = null,
            approved: string | null = null,
            approvalHash: string | null = null;
          if (
            this.db
              .prepare(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='expansion_content_authors'",
              )
              .get()
          ) {
            const author = this.db
              .prepare(
                "SELECT submitted_by,approved_by FROM expansion_content_authors WHERE project_id=? AND collection_id=? AND record_id=? AND content_revision=?",
              )
              .get(project.id, collection.id, item.id, item.contentRevision);
            if (author?.submitted_by) submitted = String(author.submitted_by);
            if (
              author?.approved_by &&
              submitted &&
              submitted !== author.approved_by &&
              this.db
                .prepare(
                  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_state'",
                )
                .get()
            ) {
              const saved = this.db
                  .prepare("SELECT value FROM runtime_state WHERE key=?")
                  .get(
                    `cms:approval:${project.id}:${collection.id}:${item.id}:${item.contentRevision}`,
                  ),
                approval = saved ? record(json(saved.value)) : {},
                {
                  workflow: _workflow,
                  status: _status,
                  contentRevision: _revision,
                  publishedAt: _publishedAt,
                  ...legacyContent
                } = original,
                fingerprint = createHash("sha256")
                  .update(JSON.stringify(legacyContent))
                  .digest("hex");
              if (
                approval.actorId === author.approved_by &&
                approval.fingerprint === fingerprint &&
                original.workflow?.approvedRevision === item.contentRevision
              ) {
                approved = String(author.approved_by);
                approvalHash = hash(authored(item));
              }
            }
          }
          this.save(
            project.id,
            collection,
            item,
            "legacy-import",
            undefined,
            submitted,
            approved,
            approvalHash,
          );
          const published = publicationRecord(original);
          // A due schedule still needs its stored approval and current permissions checked by the publication worker.
          if (
            published.workflow?.state !== "scheduled" &&
            isRecordPublished(published)
          ) {
            published.publishedAt ||= now();
            this.publish(
              project.id,
              collection,
              published,
              original.publication?.sequence ?? 0,
            );
            for (const entry of published.addressHistory ?? []) {
              const previous = this.db
                .prepare(
                  "SELECT record_id,collection_id FROM advancement_content_addresses WHERE project_id=? AND path=? AND language=?",
                )
                .get(project.id, entry.path, entry.language);
              if (
                previous &&
                (previous.record_id !== published.id ||
                  previous.collection_id !== collection.id)
              )
                throw new HttpError(
                  409,
                  "CONTENT_ADDRESS_CONFLICT",
                  "이전 공개 주소가 중복되었습니다.",
                );
              this.db
                .prepare(
                  "INSERT OR IGNORE INTO advancement_content_addresses VALUES(?,?,?,?,?,?,0)",
                )
                .run(
                  project.id,
                  entry.path,
                  entry.language,
                  collection.id,
                  published.id,
                  entry.sequence,
                );
            }
          }
        }
      }
      indexProjectReferences(this.db, project);
    });
  }
  snapshot(project: Project, view: "draft" | "published" = "draft"): Project {
    this.ensureLegacy(project);
    const collections = (
      this.db
        .prepare(
          "SELECT * FROM advancement_content_collections WHERE project_id=? ORDER BY collection_id",
        )
        .all(project.id) as unknown as (StoredCollection & {
        collection_id: string;
      })[]
    ).map((row) => {
      const collection = json<ContentCollection>(row.body);
      collection.schemaRevision = row.schema_revision;
      collection.records =
        view === "draft"
          ? (
              this.db
                .prepare(
                  "SELECT * FROM advancement_content_records WHERE project_id=? AND collection_id=? ORDER BY record_id",
                )
                .all(project.id, row.collection_id) as unknown as StoredRecord[]
            ).map((record) => this.result(record).record)
          : this.db
              .prepare(
                "SELECT p.body,p.schema_body FROM advancement_content_live l JOIN advancement_content_publications p USING(project_id,collection_id,record_id,revision) WHERE l.project_id=? AND l.collection_id=? ORDER BY l.record_id",
              )
              .all(project.id, row.collection_id)
              .map((record) =>
                publicContentRecord(
                  collection,
                  json<ContentRecord>(record.body),
                  undefined,
                  true,
                  json(record.schema_body),
                ),
              );
      if (view === "published")
        for (const item of collection.records) {
          const history = this.db
            .prepare(
              "SELECT path,language,sequence FROM advancement_content_addresses WHERE project_id=? AND collection_id=? AND record_id=? AND active=0 ORDER BY sequence,path",
            )
            .all(project.id, collection.id, item.id)
            .map((entry) => ({
              path: String(entry.path),
              language: String(entry.language),
              sequence: Number(entry.sequence),
            }));
          if (history.length) item.addressHistory = history;
        }
      return collection;
    });
    const featurePins = [...(project.featurePins ?? [])];
    if (
      collections.some((collection) =>
        collection.records.some(
          (item) => item.publication || item.translationReviews,
        ),
      ) &&
      !featurePins.some((pin) => pin.packageId === "automade.content")
    )
      featurePins.push({
        packageId: "automade.content",
        version: "1.0.0",
        integrity: "builtin:automade.content:v1",
      });
    return {
      ...project,
      collections,
      ...(featurePins.length ? { featurePins } : {}),
    };
  }
  query(
    projectId: string,
    collectionId: string,
    params: URLSearchParams,
    options: ContentQueryOptions,
  ): ContentPage {
    const project = this.project(projectId),
      { source: collection, row: metadata } = this.collection(
        projectId,
        collectionId,
        project,
      ),
      query = parseCmsQuery(
        Object.fromEntries([...params].filter(([name]) => name !== "cursor")),
      ),
      view =
        options.manage && options.view !== "published" ? "draft" : "published";
    if (collection.access === "members" && !options.member && !options.manage)
      throw new HttpError(
        401,
        "LOGIN_REQUIRED",
        "회원 로그인 후 조회할 수 있습니다.",
      );
    const sort = query.sort.replace(/^-/, ""),
      field = collection.schema?.find((item) => item.id === sort),
      language = query.language ?? "";
    if (
      !["title", "publishedAt"].includes(sort) &&
      (!field || (!options.manage && !field.public))
    )
      throw new HttpError(400, "CMS_SORT", "허용된 필드로 정렬하세요.");
    const table =
        view === "draft"
          ? "advancement_content_records"
          : "advancement_content_live",
      body = view === "draft" ? "r.body" : "p.body",
      conditions = ["r.project_id=?", "r.collection_id=?"],
      values: SQLInputValue[] = [projectId, collectionId];
    const schemaRevision = metadata.schema_revision,
      collectionRevision =
        view === "draft"
          ? metadata.revision
          : Number(
              this.db
                .prepare(
                  "SELECT publication_sequence FROM advancement_content_projects WHERE project_id=?",
                )
                .get(projectId)!.publication_sequence,
            );
    let joins =
      view === "published"
        ? " JOIN advancement_content_publications p USING(project_id,collection_id,record_id,revision)"
        : "";
    let expression =
      sort === "publishedAt"
        ? view === "published"
          ? "r.published_at"
          : "COALESCE(json_extract(r.body,'$.publishedAt'),'')"
        : "r.title";
    if (sort === "title" && language) {
      expression = `COALESCE(NULLIF(json_extract(${body},?),''),r.title)`;
      values.unshift(`$.translations."${language}".title`);
    }
    if (field) {
      joins +=
        " LEFT JOIN advancement_content_values v ON v.project_id=r.project_id AND v.collection_id=r.collection_id AND v.record_id=r.record_id AND v.view=? AND v.language=? AND v.field_id=?" +
        (!options.manage ? " AND v.public=1" : "");
      expression =
        field.type === "number"
          ? "COALESCE(v.numeric_value,0)"
          : "COALESCE(v.text_value,'')";
      values.unshift(view, language, field.id);
    }
    if (query.slug) {
      conditions.push(
        language ? `COALESCE(json_extract(${body},?),r.slug)=?` : "r.slug=?",
      );
      if (language) values.push(`$.localizedSlugs."${language}"`);
      values.push(query.slug);
    }
    if (query.q) {
      conditions.push("r.search_text LIKE ? ESCAPE '\\'");
      values.push(`%${query.q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
    }
    const fingerprint = hash([
      projectId,
      collectionId,
      collectionRevision,
      schemaRevision,
      view,
      language,
      query.q,
      query.sort,
      query.slug ?? "",
      options.member,
      options.manage ?? false,
    ]);
    const countValues = sort === "title" && language ? values.slice(1) : values;
    const total = Number(
      this.db
        .prepare(
          `SELECT count(*) AS n FROM ${table} r${joins} WHERE ${conditions.join(" AND ")}`,
        )
        .get(...countValues)!.n,
    );
    if (params.has("cursor")) {
      const token = params.get("cursor")!;
      if (token.length > 2048)
        throw new HttpError(400, "CMS_CURSOR", "조회 cursor를 확인하세요.");
      let cursor: Record<string, unknown>;
      try {
        cursor = record(
          JSON.parse(Buffer.from(token, "base64url").toString("utf8")),
        );
      } catch {
        throw new HttpError(400, "CMS_CURSOR", "조회 cursor를 확인하세요.");
      }
      if (
        cursor.fingerprint !== fingerprint ||
        typeof cursor.id !== "string" ||
        !(
          typeof cursor.value === "string" ||
          (typeof cursor.value === "number" && Number.isFinite(cursor.value))
        )
      )
        throw new HttpError(
          409,
          "CMS_CURSOR_STALE",
          "조회 조건이나 자료가 변경되었습니다. 처음부터 다시 조회하세요.",
        );
      conditions.push(
        `(${expression} ${query.sort.startsWith("-") ? "<" : ">"} ? OR (${expression}=? AND r.record_id>?))`,
      );
      if (sort === "title" && language) {
        values.push(
          `$.translations."${language}".title`,
          cursor.value,
          `$.translations."${language}".title`,
          cursor.value,
          cursor.id,
        );
      } else values.push(cursor.value, cursor.value, cursor.id);
    }
    const rows = this.db
      .prepare(
        `SELECT ${body} AS body,${view === "published" ? "p.schema_body" : "NULL"} AS schema_body,r.record_id,${expression} AS sort_value FROM ${table} r${joins} WHERE ${conditions.join(" AND ")} ORDER BY sort_value ${query.sort.startsWith("-") ? "DESC" : "ASC"},r.record_id ASC LIMIT ?`,
      )
      .all(...values, query.limit + 1) as {
      body: string;
      record_id: string;
      sort_value: string | number;
      schema_body: string | null;
    }[];
    const page = rows.slice(0, query.limit),
      references = this.snapshotReferences(
        project,
        page.map((row) => json<ContentRecord>(row.body)),
      ),
      records = page.map((row) => {
        if (view === "draft")
          return this.result(
            this.stored(projectId, collectionId, row.record_id)!,
          ).record;
        let item = json<ContentRecord>(row.body);
        if (language)
          item = localizeProject(
            { ...project, collections: [{ ...collection, records: [item] }] },
            language,
          ).collections![0]!.records[0]!;
        return publicContentRecord(
          collection,
          item,
          references,
          options.member,
          row.schema_body ? json(row.schema_body) : undefined,
        );
      });
    return {
      records,
      total,
      collectionRevision,
      schemaRevision,
      nextCursor:
        rows.length > query.limit
          ? Buffer.from(
              JSON.stringify({
                fingerprint,
                id: page.at(-1)!.record_id,
                value: page.at(-1)!.sort_value,
              }),
            ).toString("base64url")
          : null,
    };
  }
  private snapshotReferences(
    project: Project,
    records: ContentRecord[],
  ): Project {
    const requested = new Map<string, Set<string>>();
    for (const collection of project.collections ?? [])
      for (const field of collection.schema ?? [])
        if (field.type === "reference")
          for (const item of records) {
            const entries = [
              item.values,
              ...Object.values(item.translations ?? {}).map((t) => t?.values),
            ];
            for (const values of entries) {
              const value = values?.[field.id];
              const ids =
                requested.get(field.referenceCollectionId!) ??
                new Set<string>();
              for (const id of Array.isArray(value)
                ? value
                : typeof value === "string"
                  ? [value]
                  : [])
                ids.add(id);
              requested.set(field.referenceCollectionId!, ids);
            }
          }
    return {
      ...project,
      collections: project.collections?.map((collection) => ({
        ...collection,
        records: requested.get(collection.id)?.size
          ? this.db
              .prepare(
                `SELECT record_id FROM advancement_content_live WHERE project_id=? AND collection_id=? AND record_id IN (${[...requested.get(collection.id)!].map(() => "?").join(",")})`,
              )
              .all(project.id, collection.id, ...requested.get(collection.id)!)
              .map(
                (row) =>
                  ({
                    id: String(row.record_id),
                    status: "published",
                  }) as ContentRecord,
              )
          : [],
      })),
    };
  }
  routeSnapshot(project: Project): Project {
    this.ensureLegacy(project);
    return {
      ...project,
      collections: this.db
        .prepare(
          "SELECT body FROM advancement_content_collections WHERE project_id=? ORDER BY collection_id",
        )
        .all(project.id)
        .map((row) => {
          const collection = json<ContentCollection>(row.body);
          return {
            ...collection,
            records: this.db
              .prepare(
                "SELECT l.record_id,l.slug,l.published_at,json_extract(p.body,'$.localizedSlugs') AS localized_slugs FROM advancement_content_live l JOIN advancement_content_publications p USING(project_id,collection_id,record_id,revision) WHERE l.project_id=? AND l.collection_id=? ORDER BY l.record_id",
              )
              .all(project.id, collection.id)
              .map((item) => ({
                id: String(item.record_id),
                slug: String(item.slug),
                publishedAt: String(item.published_at),
                title: "",
                body: "",
                category: "",
                imageId: "",
                fields: {},
                status: "published",
                ...(item.localized_slugs
                  ? {
                      localizedSlugs: json<Record<string, string>>(
                        item.localized_slugs,
                      ),
                    }
                  : {}),
              })),
          };
        }),
    };
  }
  renderSnapshot(
    project: Project,
    selected?: { collectionId: string; recordId: string },
  ): Project {
    const result = {
      ...project,
      collections: this.db
        .prepare(
          "SELECT body FROM advancement_content_collections WHERE project_id=? ORDER BY collection_id",
        )
        .all(project.id)
        .map((row) => {
          const collection = json<ContentCollection>(row.body);
          const records = this.query(
            project.id,
            collection.id,
            new URLSearchParams({ limit: "20" }),
            { member: true },
          ).records;
          if (
            selected?.collectionId === collection.id &&
            !records.some((item) => item.id === selected.recordId)
          )
            records.push(
              this.get(project.id, collection.id, selected.recordId, {
                member: true,
              }).record,
            );
          return { ...collection, records };
        }),
    };
    return result;
  }
  get(
    projectId: string,
    collectionId: string,
    recordId: string,
    options: ContentQueryOptions,
  ): ContentRecordResult {
    const { source } = this.collection(projectId, collectionId);
    if (source.access === "members" && !options.member && !options.manage)
      throw new HttpError(
        401,
        "LOGIN_REQUIRED",
        "회원 로그인 후 조회할 수 있습니다.",
      );
    const row = this.stored(projectId, collectionId, recordId);
    if (!row)
      throw new HttpError(
        404,
        "CONTENT_NOT_FOUND",
        "콘텐츠를 찾을 수 없습니다.",
      );
    const result = this.result(row);
    if (!options.manage || options.view === "published") {
      const publication = this.published(projectId, collectionId, recordId);
      if (!publication)
        throw new HttpError(
          404,
          "CONTENT_NOT_FOUND",
          "콘텐츠를 찾을 수 없습니다.",
        );
      result.record = publicContentRecord(
        source,
        json(publication.body),
        this.snapshotReferences(this.project(projectId), [
          json<ContentRecord>(publication.body),
        ]),
        options.member,
        json(publication.schema_body),
      );
      result.recordRevision = publication.revision;
      result.fieldRevisions = {};
      result.languageRevisions = {};
      result.translations = {};
    }
    return result;
  }
  private receipt<T>(
    ctx: ContentContext,
    input: { commandId: string },
    fingerprint: unknown,
    operation: () => T,
  ): T {
    key(input.commandId);
    const digest = hash(fingerprint);
    return atomic(this.db, () => {
      ctx.assertCurrent?.();
      const previous = this.db
        .prepare(
          "SELECT * FROM advancement_content_receipts WHERE project_id=? AND command_id=?",
        )
        .get(ctx.scope.projectId, input.commandId);
      if (previous) {
        if (previous.fingerprint !== digest)
          throw new HttpError(
            409,
            "COMMAND_REUSE",
            "동일 명령 ID에 다른 내용을 사용할 수 없습니다.",
          );
        return json<T>(previous.result);
      }
      const result = operation();
      ctx.assertCurrent?.();
      this.db
        .prepare("INSERT INTO advancement_content_receipts VALUES(?,?,?,?,?)")
        .run(
          ctx.scope.projectId,
          input.commandId,
          digest,
          JSON.stringify(result),
          now(),
        );
      return result;
    });
  }
  private validate(
    project: Project,
    collection: ContentCollection,
    item: ContentRecord,
    previous?: ContentRecord,
  ): ContentRecord {
    const base: Project = {
      ...project,
      collections: project.collections?.map((c) => ({ ...c, records: [] })),
    };
    for (const field of collection.schema ?? [])
      if (field.type === "reference") {
        const values = [
            item.values?.[field.id],
            ...Object.values(item.translations ?? {}).map(
              (t) => t?.values?.[field.id],
            ),
          ],
          ids = [
            ...new Set(
              values.flatMap((value) =>
                Array.isArray(value)
                  ? value
                  : typeof value === "string"
                    ? [value]
                    : [],
              ),
            ),
          ];
        const target = base.collections?.find(
          (c) => c.id === field.referenceCollectionId,
        );
        if (target && ids.length)
          target.records = this.db
            .prepare(
              `SELECT body FROM advancement_content_records WHERE project_id=? AND collection_id=? AND record_id IN (${ids.map(() => "?").join(",")})`,
            )
            .all(project.id, target.id, ...ids)
            .map((row) => json<ContentRecord>(row.body));
      }
    const parsed = parseProject({
      ...base,
      collections: base.collections!.map((c) =>
        c.id === collection.id
          ? {
              ...collection,
              records: [item],
            }
          : c,
      ),
    })
      .collections!.find((c) => c.id === collection.id)!
      .records.find((r) => r.id === item.id)!;
    const uniqueIndex = new Map<string, Map<string, Set<string>>>();
    for (const field of collection.schema ?? [])
      if (field.unique)
        for (const language of ["", ...Object.keys(item.translations ?? {})]) {
          const value =
            language && field.localized
              ? (item.translations?.[language]?.values?.[field.id] ??
                item.values?.[field.id])
              : item.values?.[field.id];
          if (value === undefined || value === null || value === "") continue;
          const query =
            language && field.localized
              ? "SELECT v.record_id FROM advancement_content_values v WHERE v.project_id=? AND v.collection_id=? AND v.view='draft' AND v.field_id=? AND v.text_value=? AND (v.language=? OR (v.language='' AND NOT EXISTS(SELECT 1 FROM advancement_content_values t WHERE t.project_id=v.project_id AND t.collection_id=v.collection_id AND t.record_id=v.record_id AND t.view=v.view AND t.field_id=v.field_id AND t.language=?)))"
              : "SELECT record_id FROM advancement_content_values WHERE project_id=? AND collection_id=? AND view='draft' AND field_id=? AND text_value=? AND language=''";
          const entries = this.db
            .prepare(query)
            .all(
              project.id,
              collection.id,
              field.id,
              typeof value === "string" ? value : JSON.stringify(value),
              ...(language && field.localized ? [language, language] : []),
            );
          uniqueIndex.set(
            language && field.localized ? `${language}:${field.id}` : field.id,
            new Map([
              [
                JSON.stringify(value),
                new Set(entries.map((entry) => String(entry.record_id))),
              ],
            ]),
          );
        }
    const errors = validateCmsRecord(
      base,
      { ...collection, records: [parsed] },
      parsed,
      previous,
      uniqueIndex,
    );
    if (errors.length) throw new HttpError(400, "CMS_VALUES", errors.join(" "));
    return parsed;
  }
  upsert(
    ctx: ContentContext,
    collectionId: string,
    recordId: string,
    input: ContentUpsert,
  ): ContentRecordResult {
    ctx.authorize("project.edit");
    key(recordId);
    integer(input.expectedRevision);
    return this.receipt(
      ctx,
      input,
      ["upsert", collectionId, recordId, input],
      () => {
        const project = this.project(ctx.scope.projectId),
          { source: collection } = this.collection(project.id, collectionId),
          previous = this.stored(project.id, collectionId, recordId);
        if (
          previous
            ? previous.revision !== input.expectedRevision
            : input.expectedRevision !== 0
        )
          throw new HttpError(
            409,
            "CONTENT_CONFLICT",
            "콘텐츠가 변경되었습니다. 최신 버전과 비교하세요.",
          );
        const candidate = mutable(input.record);
        candidate.id = recordId;
        candidate.contentRevision = previous ? previous.revision + 1 : 0;
        candidate.status = "draft";
        candidate.workflow = { state: "draft" };
        candidate.publishedAt = previous
          ? json<ContentRecord>(previous.body).publishedAt
          : "";
        delete candidate.addressHistory;
        const parsed = this.validate(
          project,
          collection,
          candidate,
          previous ? json(previous.body) : undefined,
        );
        this.save(project.id, collection, parsed, ctx.actorId, previous);
        return this.result(this.stored(project.id, collectionId, recordId)!);
      },
    );
  }
  private event(ctx: ContentContext): number {
    const id = randomUUID(),
      projectId = ctx.scope.projectId;
    this.db
      .prepare(
        "UPDATE advancement_content_projects SET publication_sequence=publication_sequence+1,updated_at=? WHERE project_id=?",
      )
      .run(now(), projectId);
    const sequence = Number(
      this.db
        .prepare(
          "SELECT publication_sequence FROM advancement_content_projects WHERE project_id=?",
        )
        .get(projectId)!.publication_sequence,
    );
    const event = {
      id,
      scope: ctx.scope,
      kind: "content.snapshot" as const,
      sequence,
      payload: {
        revision: sequence,
        collections: this.snapshot(this.project(projectId), "published")
          .collections,
      },
      actorId: ctx.actorId,
    };
    this.db
      .prepare("INSERT INTO advancement_content_events VALUES(?,?,?,?,?)")
      .run(id, projectId, sequence, JSON.stringify(event), now());
    ctx.emit?.(event);
    return sequence;
  }
  transition(
    ctx: ContentContext,
    collectionId: string,
    recordId: string,
    input: ContentTransition,
  ): ContentRecordResult {
    const state = input.state;
    ctx.authorize(
      state === "approved"
        ? "review.approve"
        : ["published", "scheduled", "unpublish", "restore"].includes(state)
          ? "project.publish"
          : "project.edit",
    );
    integer(input.expectedRevision);
    return this.receipt(
      ctx,
      input,
      ["transition", collectionId, recordId, input],
      () => {
        const project = this.project(ctx.scope.projectId),
          { source: collection } = this.collection(project.id, collectionId),
          previous = this.stored(project.id, collectionId, recordId);
        if (!previous)
          throw new HttpError(
            404,
            "CONTENT_NOT_FOUND",
            "콘텐츠를 찾을 수 없습니다.",
          );
        if (previous.revision !== input.expectedRevision)
          throw new HttpError(
            409,
            "CONTENT_CONFLICT",
            "콘텐츠 버전이 변경되었습니다.",
          );
        let item = json<ContentRecord>(previous.body),
          submitted = previous.submitted_by,
          approved = previous.approved_by,
          approvalHash = previous.approval_hash;
        if (state === "approved" && (!submitted || submitted === ctx.actorId))
          throw new HttpError(
            409,
            "REVIEW_SELF_APPROVAL",
            "작성자와 다른 검토자가 승인해야 합니다.",
          );
        if (
          ["published", "scheduled"].includes(state) &&
          (!approved || approvalHash !== hash(authored(item)))
        )
          throw new HttpError(
            409,
            "CONTENT_APPROVAL",
            "현재 콘텐츠에 대한 검토 승인이 필요합니다.",
          );
        if (["published", "scheduled"].includes(state) && approved)
          ctx.assertApprover?.(approved);
        if (state === "unpublish") {
          this.db
            .prepare(
              "DELETE FROM advancement_content_live WHERE project_id=? AND collection_id=? AND record_id=?",
            )
            .run(project.id, collectionId, recordId);
          this.db
            .prepare(
              "DELETE FROM advancement_content_values WHERE project_id=? AND collection_id=? AND record_id=? AND view='published'",
            )
            .run(project.id, collectionId, recordId);
          this.db
            .prepare(
              "UPDATE advancement_content_addresses SET active=0 WHERE project_id=? AND collection_id=? AND record_id=?",
            )
            .run(project.id, collectionId, recordId);
          this.db
            .prepare(
              "UPDATE advancement_content_records SET published_revision=NULL WHERE project_id=? AND collection_id=? AND record_id=?",
            )
            .run(project.id, collectionId, recordId);
          item.status = "draft";
          item.workflow = { state: "draft" };
          this.save(project.id, collection, item, ctx.actorId, previous);
          this.event(ctx);
        } else if (state === "restore") {
          const publication = this.db
            .prepare(
              "SELECT * FROM advancement_content_publications WHERE project_id=? AND collection_id=? AND record_id=? AND revision=?",
            )
            .get(
              project.id,
              collectionId,
              recordId,
              integer(input.publicationRevision),
            ) as unknown as StoredPublication | undefined;
          if (!publication)
            throw new HttpError(
              404,
              "PUBLICATION_NOT_FOUND",
              "발행본을 찾을 수 없습니다.",
            );
          const restored = json<ContentRecord>(publication.body);
          this.publish(
            project.id,
            {
              ...collection,
              schema: json(publication.schema_body),
              schemaRevision: publication.schema_revision,
            },
            restored,
            this.nextSequence(project.id),
          );
          this.bump(project.id, collectionId);
          this.event(ctx);
        } else {
          item = transitionContent(item, state, input.publishAt);
          if (state === "review") {
            submitted = ctx.actorId;
            approved = null;
            approvalHash = null;
          }
          if (state === "approved") {
            approved = ctx.actorId;
            approvalHash = hash(authored(item));
          }
          if (state === "published") {
            const errors = validateCmsRecord(
              this.snapshot(project),
              collection,
              item,
            );
            if (errors.length)
              throw new HttpError(400, "CMS_VALUES", errors.join(" "));
            item.publishedAt = now();
            this.publish(
              project.id,
              collection,
              item,
              this.nextSequence(project.id),
            );
          }
          this.save(
            project.id,
            collection,
            item,
            ctx.actorId,
            previous,
            submitted,
            approved,
            approvalHash,
          );
          if (state === "published") this.event(ctx);
        }
        return this.result(this.stored(project.id, collectionId, recordId)!);
      },
    );
  }
  private nextSequence(projectId: string): number {
    return (
      Number(
        this.db
          .prepare(
            "SELECT publication_sequence FROM advancement_content_projects WHERE project_id=?",
          )
          .get(projectId)!.publication_sequence,
      ) + 1
    );
  }
  runScheduled(
    contextFor: (projectId: string, actorId: string) => ContentContext,
    limit = 100,
  ): number {
    let count = 0;
    const rows = this.db
      .prepare(
        "SELECT project_id,collection_id,record_id,revision,approved_by,json_extract(body,'$.workflow.publishAt') AS publish_at FROM advancement_content_records WHERE workflow='scheduled' AND json_extract(body,'$.workflow.publishAt')<=? ORDER BY publish_at,record_id LIMIT ?",
      )
      .all(now(), Math.min(500, Math.max(1, limit)));
    for (const row of rows) {
      const actor = String(row.approved_by ?? "");
      const ctx = contextFor(String(row.project_id), actor);
      ctx.authorize("review.approve");
      ctx.authorize("project.publish");
      this.transition(ctx, String(row.collection_id), String(row.record_id), {
        state: "published",
        expectedRevision: Number(row.revision),
        commandId: `scheduled_${hash([row.project_id, row.collection_id, row.record_id, row.revision]).slice(0, 48)}`,
      });
      count++;
    }
    return count;
  }
  translation(
    ctx: ContentContext,
    collectionId: string,
    recordId: string,
    language: string,
    input: {
      state: TranslationReview["state"];
      expectedRevision: number;
      commandId: string;
      assignee?: string;
      glossaryVersion?: number;
    },
  ): ContentRecordResult {
    ctx.authorize(
      input.state === "approved" ? "review.approve" : "project.edit",
    );
    return this.receipt(
      ctx,
      input,
      ["translation", collectionId, recordId, language, input],
      () => {
        const row = this.stored(ctx.scope.projectId, collectionId, recordId);
        if (!row || row.revision !== integer(input.expectedRevision))
          throw new HttpError(
            409,
            "CONTENT_CONFLICT",
            "콘텐츠 버전이 변경되었습니다.",
          );
        if (
          !siteLanguages(this.project(ctx.scope.projectId)).includes(language)
        )
          throw new HttpError(
            400,
            "LANGUAGE",
            "사이트에 등록된 언어를 선택하세요.",
          );
        const item = json<ContentRecord>(row.body),
          reviews = json<Record<string, TranslationReview>>(
            row.translation_reviews,
          );
        if (
          input.state === "approved" &&
          (reviews[language]?.state !== "review" ||
            reviews[language]?.assignee === ctx.actorId ||
            reviews[language]?.changedFields.length)
        )
          throw new HttpError(
            409,
            "TRANSLATION_REVIEW",
            "최신 원문에 대한 별도 검토가 필요합니다.",
          );
        reviews[language] = {
          sourceRevision: row.revision,
          sourceFieldHashes: Object.fromEntries(
            Object.entries(contentSourceFields(item)).map(([path, value]) => [
              path,
              hash(value),
            ]),
          ),
          changedFields: [],
          state: input.state,
          ...(input.assignee ? { assignee: input.assignee } : {}),
          ...(input.state === "approved" ? { reviewer: ctx.actorId } : {}),
          ...(input.glossaryVersion === undefined
            ? {}
            : { glossaryVersion: integer(input.glossaryVersion) }),
        };
        this.db
          .prepare(
            "UPDATE advancement_content_records SET translation_reviews=? WHERE project_id=? AND collection_id=? AND record_id=?",
          )
          .run(
            JSON.stringify(reviews),
            ctx.scope.projectId,
            collectionId,
            recordId,
          );
        this.bump(ctx.scope.projectId, collectionId);
        return this.result(
          this.stored(ctx.scope.projectId, collectionId, recordId)!,
        );
      },
    );
  }
  schemaPreview(
    ctx: ContentContext,
    collectionId: string,
    input: { schema: unknown },
  ): ContentMigrationPlan {
    ctx.authorize("project.edit");
    const project = this.snapshot(this.project(ctx.scope.projectId)),
      { source: collection, row } = this.collection(
        ctx.scope.projectId,
        collectionId,
        project,
      ),
      targetSchema = parseCmsSchema(input.schema),
      plan: ContentMigrationPlan = {
        id: randomUUID(),
        collectionId,
        sourceSchemaRevision: row.schema_revision,
        sourceCollectionRevision: row.revision,
        sourceSchema: structuredClone(collection.schema ?? []),
        targetSchema,
        state: "preview",
        checkpoint: "",
        processed: 0,
        changes: 0,
        errors: [],
      };
    const originals =
        project.collections?.find((item) => item.id === collectionId)
          ?.records ?? [],
      transformed = originals.map((record) =>
        transformSchemaValues(record, targetSchema),
      ),
      target = {
        ...collection,
        schema: targetSchema,
        records: transformed.map((item) => item.record),
      },
      validationProject = {
        ...project,
        collections: project.collections?.map((item) =>
          item.id === collectionId ? target : item,
        ),
      },
      errors = transformed.flatMap((item) => {
        const errors = validateCmsRecord(
          validationProject,
          target,
          item.record,
        );
        return errors.length ? [{ recordId: item.record.id, errors }] : [];
      });
    plan.preview = {
      records: originals.length,
      changes: transformed.reduce((count, item) => count + item.changes, 0),
      invalidRecords: errors.length,
      errors,
    };
    this.db
      .prepare(
        "INSERT INTO advancement_content_migrations VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        plan.id,
        ctx.scope.projectId,
        collectionId,
        JSON.stringify(plan),
        plan.state,
        "",
        0,
        now(),
      );
    return plan;
  }
  schemaRun(
    ctx: ContentContext,
    migrationId: string,
    input: { limit?: number } = {},
  ): ContentMigrationPlan {
    ctx.authorize("project.edit");
    return atomic(this.db, () => {
      ctx.assertCurrent?.();
      const saved = this.db
        .prepare(
          "SELECT * FROM advancement_content_migrations WHERE id=? AND project_id=?",
        )
        .get(migrationId, ctx.scope.projectId);
      if (!saved)
        throw new HttpError(
          404,
          "CMS_MIGRATION",
          "이전 작업을 찾을 수 없습니다.",
        );
      const plan = json<ContentMigrationPlan>(saved.body);
      if (["complete", "cancelled"].includes(plan.state)) return plan;
      const project = this.project(ctx.scope.projectId),
        { source: collection, row } = this.collection(
          project.id,
          plan.collectionId,
        );
      if (row.schema_revision !== plan.sourceSchemaRevision)
        throw new HttpError(
          409,
          "CMS_SCHEMA_CONFLICT",
          "컬렉션 모델이 변경되었습니다.",
        );
      if (
        plan.sourceCollectionRevision !== undefined &&
        row.revision !== plan.sourceCollectionRevision
      )
        throw new HttpError(
          409,
          "CMS_MIGRATION_CONFLICT",
          "이전 검토 이후 콘텐츠가 변경되었습니다. 최신 자료로 다시 검토하세요.",
        );
      const limit = input.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new HttpError(400, "CMS_BATCH", "배치 크기는 1~500입니다.");
      const records = this.db
        .prepare(
          "SELECT * FROM advancement_content_records WHERE project_id=? AND collection_id=? AND record_id>? ORDER BY record_id LIMIT ?",
        )
        .all(
          project.id,
          collection.id,
          plan.checkpoint,
          limit,
        ) as unknown as StoredRecord[];
      const validationProject = this.snapshot(project),
        target = {
          ...collection,
          schema: plan.targetSchema,
          schemaRevision: plan.sourceSchemaRevision + 1,
        };
      for (const stored of records) {
        const converted = transformSchemaValues(
            json<ContentRecord>(stored.body),
            plan.targetSchema,
          ),
          item = converted.record;
        plan.changes += converted.changes;
        const errors = validateCmsRecord(
          validationProject,
          {
            ...target,
            records: validationProject.collections!.find(
              (c) => c.id === collection.id,
            )!.records,
          },
          item,
        );
        this.db
          .prepare(
            "INSERT OR REPLACE INTO advancement_content_candidates VALUES(?,?,?,?,?)",
          )
          .run(
            plan.id,
            item.id,
            stored.revision,
            JSON.stringify(item),
            JSON.stringify(errors),
          );
        if (errors.length) plan.errors.push({ recordId: item.id, errors });
        plan.checkpoint = item.id;
        plan.processed++;
      }
      plan.state =
        records.length === limit
          ? "running"
          : plan.errors.length
            ? "blocked"
            : "complete";
      if (plan.state === "complete") {
        const candidates = this.db
          .prepare(
            "SELECT * FROM advancement_content_candidates WHERE migration_id=? ORDER BY record_id",
          )
          .all(plan.id);
        for (const candidate of candidates) {
          const current = this.stored(
            project.id,
            collection.id,
            String(candidate.record_id),
          );
          if (!current || current.revision !== candidate.expected_revision)
            throw new HttpError(
              409,
              "CMS_MIGRATION_CONFLICT",
              "이전 중 콘텐츠가 수정되었습니다. 새 검토가 필요합니다.",
            );
        }
        this.db
          .prepare(
            "UPDATE advancement_content_collections SET body=?,schema_revision=?,revision=revision+1 WHERE project_id=? AND collection_id=?",
          )
          .run(
            JSON.stringify({ ...target, records: [] }),
            target.schemaRevision,
            project.id,
            collection.id,
          );
        for (const candidate of candidates) {
          const item = json<ContentRecord>(candidate.body);
          item.contentRevision = Number(candidate.expected_revision) + 1;
          item.status = "draft";
          item.workflow = { state: "draft" };
          this.save(
            project.id,
            target,
            item,
            ctx.actorId,
            this.stored(project.id, collection.id, item.id),
          );
        }
      }
      this.db
        .prepare(
          "UPDATE advancement_content_migrations SET body=?,state=?,checkpoint=?,processed=? WHERE id=?",
        )
        .run(
          JSON.stringify(plan),
          plan.state,
          plan.checkpoint,
          plan.processed,
          plan.id,
        );
      ctx.assertCurrent?.();
      return plan;
    });
  }
  impact(
    ctx: ContentContext,
    targetType: string,
    targetId: string,
  ): { revision: number; references: Record<string, unknown>[] } {
    ctx.authorize("project.read");
    const project = this.project(ctx.scope.projectId);
    return {
      revision:
        project.revision +
        Number(
          this.db
            .prepare(
              "SELECT COALESCE(sum(revision),0) AS revision FROM advancement_content_collections WHERE project_id=?",
            )
            .get(project.id)!.revision,
        ),
      references: this.db
        .prepare(
          "SELECT source_type,source_id,target_type,target_id,path,revision FROM advancement_content_reference_edges WHERE project_id=? AND target_type=? AND target_id=? ORDER BY source_type,source_id,path",
        )
        .all(project.id, targetType, targetId),
    };
  }
  address(
    projectId: string,
    path: string,
    language: string,
    member: boolean,
  ): {
    collectionId: string;
    recordId: string;
    path: string;
    redirect: boolean;
  } | null {
    this.project(projectId);
    const row = this.db
      .prepare(
        "SELECT * FROM advancement_content_addresses WHERE project_id=? AND path=? AND language=?",
      )
      .get(projectId, path, language);
    if (!row) return null;
    const { source: collection } = this.collection(
      projectId,
      String(row.collection_id),
    );
    if (collection.access === "members" && !member)
      throw new HttpError(
        401,
        "LOGIN_REQUIRED",
        "회원 로그인 후 조회할 수 있습니다.",
      );
    if (!this.published(projectId, collection.id, String(row.record_id)))
      return null;
    const current = this.db
      .prepare(
        "SELECT path FROM advancement_content_addresses WHERE project_id=? AND collection_id=? AND record_id=? AND language=? AND active=1",
      )
      .get(projectId, collection.id, String(row.record_id), language);
    return current
      ? {
          collectionId: collection.id,
          recordId: String(row.record_id),
          path: String(current.path),
          redirect: row.active !== 1,
        }
      : null;
  }
}

export function hydrateContentProject(
  db: DatabaseSync,
  source: Project,
): Project {
  return new IndexedContentService(db, (id) =>
    id === source.id ? source : null,
  ).snapshot(source);
}
/** The canonical indexed store is authoritative. Unchanged legacy fields cannot overwrite concurrent record edits. */
export function reconcileContentWrite(
  db: DatabaseSync,
  previousRaw: Project | null,
  incoming: Project,
  context?: ContentContext,
): Project {
  const service = new IndexedContentService(db, (id) =>
    id === incoming.id ? (previousRaw ?? incoming) : null,
  );
  service.ensureLegacy(previousRaw ?? incoming);
  return atomic(db, () => {
    const current = service.snapshot(previousRaw ?? incoming);
    if (context && context.scope.projectId !== incoming.id)
      throw new HttpError(
        403,
        "CONTENT_SCOPE",
        "콘텐츠 수정 범위가 프로젝트와 다릅니다.",
      );
    const writeContext: ContentContext = context ?? {
      scope: {
        organizationId: "local",
        workspaceId: "local",
        projectId: incoming.id,
      },
      actorId: "legacy-editor",
      authorize: () => {},
    };
    indexProjectReferences(db, incoming);
    for (const collection of incoming.collections ?? []) {
      const prior = previousRaw?.collections?.find(
          (c) => c.id === collection.id,
        ),
        canonical = current.collections?.find((c) => c.id === collection.id);
      if (!canonical) {
        db.prepare(
          "INSERT INTO advancement_content_collections VALUES(?,?,?,?,?)",
        ).run(
          incoming.id,
          collection.id,
          JSON.stringify({ ...collection, records: [] }),
          0,
          collection.schemaRevision ?? 0,
        );
      } else if (
        hash({ ...collection, records: [] }) !== hash({ ...prior, records: [] })
      ) {
        if (
          hash(collection.schema ?? []) !== hash(canonical.schema ?? []) ||
          (collection.schemaRevision ?? 0) !== (canonical.schemaRevision ?? 0)
        )
          throw new HttpError(
            409,
            "CMS_SCHEMA_CONFLICT",
            "모델 변경은 서버의 스키마 검토와 배치 이전을 완료한 뒤 저장하세요.",
          );
        db.prepare(
          "UPDATE advancement_content_collections SET body=?,schema_revision=?,revision=revision+1 WHERE project_id=? AND collection_id=?",
        ).run(
          JSON.stringify({ ...collection, records: [] }),
          collection.schemaRevision ?? 0,
          incoming.id,
          collection.id,
        );
      }
      for (const item of collection.records) {
        const old = prior?.records.find((r) => r.id === item.id),
          actual = canonical?.records.find((r) => r.id === item.id);
        const workflow = (value: ContentRecord): unknown => [
            value.workflow?.state ?? value.status,
            value.workflow?.publishAt ?? null,
          ],
          contentChanged = !old || hash(authored(item)) !== hash(authored(old)),
          workflowChanged = Boolean(
            old && hash(workflow(item)) !== hash(workflow(old)),
          );
        if (!contentChanged && !workflowChanged) continue;
        if (
          actual &&
          hash(authored(actual)) === hash(authored(item)) &&
          hash(workflow(actual)) === hash(workflow(item))
        )
          continue;
        if (
          actual &&
          (old?.contentRevision ?? 0) !== (actual.contentRevision ?? 0) &&
          (item.contentRevision ?? 0) !== (actual.contentRevision ?? 0) + 1
        )
          throw new HttpError(
            409,
            "CONTENT_CONFLICT",
            "콘텐츠가 별도로 수정되었습니다. 최신 버전과 비교하세요.",
          );
        if (workflowChanged && !context)
          throw new HttpError(
            403,
            "CONTENT_CONTEXT",
            "콘텐츠 상태 변경에는 실제 실행자와 권한 범위가 필요합니다.",
          );
        if (
          workflowChanged &&
          actual &&
          old &&
          hash(workflow(actual)) !== hash(workflow(old))
        )
          throw new HttpError(
            409,
            "CONTENT_CONFLICT",
            "검토 상태가 별도로 변경되었습니다. 최신 버전을 확인하세요.",
          );
        let revision = actual?.contentRevision ?? 0;
        if (
          contentChanged &&
          (!actual || hash(authored(actual)) !== hash(authored(item)))
        ) {
          revision = service.upsert(writeContext, collection.id, item.id, {
            record: item,
            expectedRevision: actual?.contentRevision ?? 0,
            commandId: `legacy_${hash([incoming.revision, collection.id, item.id, authored(item)]).slice(0, 48)}`,
          }).recordRevision;
        }
        if (workflowChanged) {
          const state = item.workflow?.state ?? item.status;
          if (state === "archived" && actual?.publication)
            service.transition(writeContext, collection.id, item.id, {
              state: "unpublish",
              expectedRevision: revision,
              commandId: `legacy_unpublish_${hash([incoming.revision, collection.id, item.id, state]).slice(0, 48)}`,
            });
          service.transition(writeContext, collection.id, item.id, {
            state,
            expectedRevision: revision,
            commandId: `legacy_transition_${hash([incoming.revision, collection.id, item.id, state, item.workflow?.publishAt ?? null]).slice(0, 48)}`,
            ...(item.workflow?.publishAt
              ? { publishAt: item.workflow.publishAt }
              : {}),
          });
        }
      }
      for (const old of prior?.records ?? [])
        if (!collection.records.some((r) => r.id === old.id)) {
          if (
            db
              .prepare(
                "SELECT 1 FROM advancement_content_live WHERE project_id=? AND collection_id=? AND record_id=?",
              )
              .get(incoming.id, collection.id, old.id)
          )
            throw new HttpError(
              409,
              "CONTENT_PUBLISHED",
              "공개 중인 자료는 먼저 발행 취소를 검토한 뒤 삭제하세요.",
            );
          const refs = service.impact(
            writeContext,
            "record",
            `${collection.id}/${old.id}`,
          ).references;
          if (refs.length)
            throw new HttpError(
              409,
              "CONTENT_REFERENCED",
              "연결된 콘텐츠는 삭제할 수 없습니다.",
            );
          const actual = canonical?.records.find((r) => r.id === old.id);
          if (
            actual &&
            (actual.contentRevision ?? 0) !== (old.contentRevision ?? 0)
          )
            throw new HttpError(
              409,
              "CONTENT_CONFLICT",
              "별도로 수정된 콘텐츠를 삭제할 수 없습니다.",
            );
          for (const table of [
            "advancement_content_records",
            "advancement_content_live",
            "advancement_content_values",
          ])
            db.prepare(
              `DELETE FROM ${table} WHERE project_id=? AND collection_id=? AND record_id=?`,
            ).run(incoming.id, collection.id, old.id);
        }
    }
    for (const old of previousRaw?.collections ?? []) {
      if (incoming.collections?.some((collection) => collection.id === old.id))
        continue;
      if (
        db
          .prepare(
            "SELECT 1 FROM advancement_content_live WHERE project_id=? AND collection_id=? LIMIT 1",
          )
          .get(incoming.id, old.id)
      )
        throw new HttpError(
          409,
          "CONTENT_PUBLISHED",
          "공개 중인 컬렉션은 자료의 발행 취소를 먼저 검토하세요.",
        );
      if (
        db
          .prepare(
            "SELECT 1 FROM advancement_content_reference_edges WHERE project_id=? AND ((target_type='collection' AND target_id=?) OR (target_type='record' AND target_id LIKE ?)) LIMIT 1",
          )
          .get(incoming.id, old.id, `${old.id}/%`)
      )
        throw new HttpError(
          409,
          "CONTENT_REFERENCED",
          "사용 중인 컬렉션은 연결을 해제하거나 대체한 뒤 삭제하세요.",
        );
      const canonical = current.collections?.find(
        (collection) => collection.id === old.id,
      );
      if (
        canonical?.records.some(
          (item) =>
            !old.records.some(
              (prior) =>
                prior.id === item.id &&
                (prior.contentRevision ?? 0) === (item.contentRevision ?? 0),
            ),
        )
      )
        throw new HttpError(
          409,
          "CONTENT_CONFLICT",
          "별도로 수정된 컬렉션은 최신 자료를 검토한 뒤 삭제하세요.",
        );
      for (const table of [
        "advancement_content_records",
        "advancement_content_values",
        "advancement_content_collections",
      ])
        db.prepare(
          `DELETE FROM ${table} WHERE project_id=? AND collection_id=?`,
        ).run(incoming.id, old.id);
    }
    indexProjectReferences(db, incoming);
    for (const asset of previousRaw?.assets ?? [])
      if (
        !incoming.assets.some((item) => item.id === asset.id) &&
        db
          .prepare(
            "SELECT 1 FROM advancement_content_reference_edges WHERE project_id=? AND target_type='asset' AND target_id=? LIMIT 1",
          )
          .get(incoming.id, asset.id)
      )
        throw new HttpError(
          409,
          "ASSET_REFERENCED",
          "사용 중인 이미지의 연결을 해제하거나 대체한 뒤 삭제하세요.",
        );
    return service.snapshot(incoming);
  });
}
export function indexProjectReferences(
  db: DatabaseSync,
  project: Project,
): void {
  db.prepare(
    "DELETE FROM advancement_content_reference_edges WHERE project_id=? AND source_type IN('block','component','package','page')",
  ).run(project.id);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO advancement_content_reference_edges VALUES(?,?,?,?,?,?,?)",
  );
  for (const block of project.blocks)
    for (const ref of blockReferences(block))
      insert.run(
        project.id,
        "block",
        block.id,
        ref.type,
        ref.id,
        ref.path,
        project.revision,
      );
  for (const component of project.components ?? [])
    for (const block of component.blocks)
      for (const ref of blockReferences(block))
        insert.run(
          project.id,
          "component",
          component.id,
          ref.type,
          ref.id,
          `${block.id}.${ref.path}`,
          component.version,
        );
  for (const page of project.pages)
    if (page.seo?.imageAssetId)
      insert.run(
        project.id,
        "page",
        page.id,
        "asset",
        page.seo.imageAssetId,
        "seo.imageAssetId",
        project.revision,
      );
  for (const pack of project.blockPackages ?? [])
    for (const dependency of pack.dependencies ?? [])
      insert.run(
        project.id,
        "package",
        pack.id,
        "package",
        dependency.packageId,
        `dependencies.${dependency.packageId}`,
        project.revision,
      );
}
/** Consumers replace indexes only after an accepted publication sequence. No drafts are retained as live rows. */
export function applyRuntimeContentSnapshot(
  db: DatabaseSync,
  project: Project,
  snapshot: unknown,
): void {
  const input = record(snapshot);
  integer(input.revision);
  if (!Array.isArray(input.collections))
    throw new ValidationError("CMS 스냅샷을 확인하세요.");
  const source = parseProject({ ...project, collections: input.collections });
  const service = new IndexedContentService(db, (id) =>
    id === project.id ? source : null,
  );
  atomic(db, () => {
    const previous = db
      .prepare(
        "SELECT publication_sequence FROM advancement_content_projects WHERE project_id=?",
      )
      .get(project.id);
    if (
      previous &&
      Number(previous.publication_sequence) >= Number(input.revision)
    )
      return;
    for (const table of [
      "advancement_content_projects",
      "advancement_content_collections",
      "advancement_content_records",
      "advancement_content_revisions",
      "advancement_content_publications",
      "advancement_content_live",
      "advancement_content_values",
      "advancement_content_addresses",
      "advancement_content_reference_edges",
    ])
      db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(project.id);
    service.ensureLegacy(source);
    db.prepare(
      "UPDATE advancement_content_projects SET publication_sequence=? WHERE project_id=?",
    ).run(Number(input.revision), project.id);
  });
}
