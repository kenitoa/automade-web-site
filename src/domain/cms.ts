import type {
  CmsFieldDefinition,
  CmsQueryResult,
  CmsValue,
  ContentCollection,
  ContentRecord,
  ContentWorkflow,
  Project,
} from "./types";
import { parseProject, record, ValidationError } from "./validation";
import { normalizeLanguage } from "./languages";
import { localizeProject } from "./localization";
import { publicationRecord } from "./contentState";

const identifier = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(value) ||
    ["__proto__", "constructor", "prototype"].includes(value)
  )
    throw new ValidationError("올바른 CMS 필드 ID가 필요합니다.");
  return value;
};
export function parseCmsSchema(value: unknown): CmsFieldDefinition[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new ValidationError("CMS 필드는 최대 100개입니다.");
  const result = value.map((entry): CmsFieldDefinition => {
    const input = record(entry),
      type = input.type;
    if (
      ![
        "text",
        "number",
        "boolean",
        "date",
        "enum",
        "image",
        "reference",
      ].includes(String(type))
    )
      throw new ValidationError("CMS 필드 형식을 확인하세요.");
    if (typeof input.label !== "string" || input.label.length > 200)
      throw new ValidationError("CMS 필드 이름을 확인하세요.");
    const field: CmsFieldDefinition = {
      id: identifier(input.id),
      label: input.label,
      type: type as CmsFieldDefinition["type"],
    };
    for (const key of [
      "required",
      "unique",
      "public",
      "readOnly",
      "localized",
    ] as const)
      if (input[key] !== undefined) {
        if (typeof input[key] !== "boolean")
          throw new ValidationError("CMS 필드 설정은 참/거짓이어야 합니다.");
        field[key] = input[key];
      }
    for (const key of ["min", "max"] as const)
      if (input[key] !== undefined) {
        if (typeof input[key] !== "number" || !Number.isFinite(input[key]))
          throw new ValidationError("CMS 범위는 유한한 숫자여야 합니다.");
        field[key] = input[key];
      }
    if (
      field.min !== undefined &&
      field.max !== undefined &&
      field.min > field.max
    )
      throw new ValidationError("CMS 최소 범위가 최대 범위를 초과합니다.");
    if (input.options !== undefined) {
      if (
        !Array.isArray(input.options) ||
        input.options.length > 100 ||
        input.options.some(
          (option) => typeof option !== "string" || option.length > 200,
        )
      )
        throw new ValidationError("CMS 선택값을 확인하세요.");
      field.options = input.options;
    }
    if (input.referenceCollectionId !== undefined)
      field.referenceCollectionId = identifier(input.referenceCollectionId);
    if (field.type === "reference" && !field.referenceCollectionId)
      throw new ValidationError("관계 필드의 대상 컬렉션이 필요합니다.");
    if (field.type === "enum" && !field.options?.length)
      throw new ValidationError("선택 필드의 선택값이 필요합니다.");
    return field;
  });
  if (new Set(result.map((field) => field.id)).size !== result.length)
    throw new ValidationError("CMS 필드 ID가 중복됩니다.");
  return result;
}
export function parseCmsValues(value: unknown): Record<string, CmsValue> {
  const entries = Object.entries(record(value));
  if (entries.length > 100)
    throw new ValidationError("CMS 값은 최대 100개입니다.");
  return Object.fromEntries(
    entries.map(([key, input]) => {
      identifier(key);
      if (
        input !== null &&
        typeof input !== "string" &&
        typeof input !== "boolean" &&
        !(typeof input === "number" && Number.isFinite(input)) &&
        !(
          Array.isArray(input) &&
          input.length <= 100 &&
          input.every(
            (value) => typeof value === "string" && value.length <= 100,
          )
        )
      )
        throw new ValidationError("지원하지 않는 CMS 값입니다.");
      if (typeof input === "string" && input.length > 50000)
        throw new ValidationError("CMS 텍스트는 최대 50000자입니다.");
      return [key, input as CmsValue];
    }),
  );
}
export function parseContentWorkflow(value: unknown): ContentWorkflow {
  const input = record(value);
  if (
    ![
      "draft",
      "review",
      "approved",
      "scheduled",
      "published",
      "archived",
    ].includes(String(input.state))
  )
    throw new ValidationError("발행 상태를 확인하세요.");
  const workflow: ContentWorkflow = {
    state: input.state as ContentWorkflow["state"],
  };
  if (input.publishAt !== undefined) {
    if (
      typeof input.publishAt !== "string" ||
      !Number.isFinite(Date.parse(input.publishAt))
    )
      throw new ValidationError("예약 발행 시각을 확인하세요.");
    workflow.publishAt = new Date(input.publishAt).toISOString();
  }
  if (input.approvedRevision !== undefined) {
    if (
      typeof input.approvedRevision !== "number" ||
      !Number.isSafeInteger(input.approvedRevision) ||
      input.approvedRevision < 0
    )
      throw new ValidationError("승인 버전을 확인하세요.");
    workflow.approvedRevision = input.approvedRevision;
  }
  if (workflow.state === "scheduled" && !workflow.publishAt)
    throw new ValidationError("예약 발행 시각이 필요합니다.");
  return workflow;
}
export function isRecordPublished(
  record: ContentRecord,
  now: string = new Date().toISOString(),
  allowDueSchedule = true,
): boolean {
  if (record.publication)
    return isRecordPublished(publicationRecord(record), now, allowDueSchedule);
  if (!record.workflow) return record.status === "published";
  if (record.workflow.approvedRevision !== (record.contentRevision ?? 0))
    return false;
  return (
    record.workflow.state === "published" ||
    (allowDueSchedule &&
      record.workflow.state === "scheduled" &&
      Boolean(record.workflow.publishAt) &&
      Date.parse(record.workflow.publishAt!) <= Date.parse(now))
  );
}
export function validateCmsRecord(
  project: Project,
  collection: ContentCollection,
  value: ContentRecord,
  previous?: ContentRecord,
  uniqueIndex?: Map<string, Map<string, Set<string>>>,
): string[] {
  const errors: string[] = [];
  for (const field of collection.schema ?? []) {
    const input = value.values?.[field.id],
      uniqueIds = uniqueIndex?.get(field.id)?.get(JSON.stringify(input)),
      empty =
        input === undefined ||
        input === null ||
        input === "" ||
        (Array.isArray(input) && !input.length);
    if (
      field.readOnly &&
      previous &&
      JSON.stringify(previous.values?.[field.id]) !== JSON.stringify(input)
    )
      errors.push(`${field.label}: 읽기 전용 값입니다.`);
    if (empty) {
      if (field.required) errors.push(`${field.label}: 필수값이 필요합니다.`);
      continue;
    }
    if (
      field.unique &&
      (uniqueIndex
        ? Boolean(uniqueIds && (uniqueIds.size > 1 || !uniqueIds.has(value.id)))
        : collection.records.some(
            (candidate) =>
              candidate.id !== value.id &&
              JSON.stringify(candidate.values?.[field.id]) ===
                JSON.stringify(input),
          ))
    )
      errors.push(`${field.label}: 중복값을 사용할 수 없습니다.`);
    if (
      field.type === "number" &&
      (typeof input !== "number" ||
        (field.min !== undefined && input < field.min) ||
        (field.max !== undefined && input > field.max))
    )
      errors.push(`${field.label}: 숫자와 범위를 확인하세요.`);
    if (field.type === "boolean" && typeof input !== "boolean")
      errors.push(`${field.label}: 참/거짓 값이 필요합니다.`);
    if (
      ["text", "enum", "date", "image"].includes(field.type) &&
      typeof input !== "string"
    )
      errors.push(`${field.label}: 문자열이 필요합니다.`);
    if (
      field.type === "text" &&
      typeof input === "string" &&
      ((field.min !== undefined && input.length < field.min) ||
        (field.max !== undefined && input.length > field.max))
    )
      errors.push(`${field.label}: 글자 수 범위를 확인하세요.`);
    if (field.type === "enum" && !field.options?.includes(String(input)))
      errors.push(`${field.label}: 선택값을 확인하세요.`);
    if (
      field.type === "date" &&
      (typeof input !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(input) ||
        !Number.isFinite(Date.parse(`${input}T00:00:00Z`)) ||
        new Date(`${input}T00:00:00Z`).toISOString().slice(0, 10) !== input)
    )
      errors.push(`${field.label}: 실제 날짜를 입력하세요.`);
    if (
      field.type === "image" &&
      !project.assets.some((asset) => asset.id === input)
    )
      errors.push(`${field.label}: 이미지가 없습니다.`);
    if (field.type === "reference") {
      const targets = Array.isArray(input)
          ? input
          : typeof input === "string"
            ? [input]
            : [],
        target = project.collections?.find(
          (candidate) => candidate.id === field.referenceCollectionId,
        );
      if (
        !targets.length ||
        targets.some(
          (id) => !target?.records.some((candidate) => candidate.id === id),
        )
      )
        errors.push(`${field.label}: 연결된 콘텐츠가 없습니다.`);
    }
  }
  for (const key of Object.keys(value.values ?? {}))
    if (!collection.schema?.some((field) => field.id === key))
      errors.push(`정의되지 않은 CMS 필드: ${key}`);
  for (const [language, translated] of Object.entries(value.translations ?? {}))
    if (translated?.values) {
      for (const id of Object.keys(translated.values))
        if (
          !collection.schema?.some(
            (field) => field.id === id && field.localized,
          )
        )
          errors.push(`${language}: 번역 가능한 CMS 필드가 아닙니다: ${id}`);
      const child = {
        ...value,
        values: { ...value.values, ...translated.values },
        translations: undefined,
      };
      const availableIndexes = uniqueIndex ?? createCmsUniqueIndex(collection);
      errors.push(
        ...validateCmsRecord(
          project,
          collection,
          child,
          previous
            ? {
                ...previous,
                values: {
                  ...previous.values,
                  ...previous.translations?.[language]?.values,
                },
                translations: undefined,
              }
            : undefined,
          new Map(
            (collection.schema ?? [])
              .filter((field) => field.unique)
              .map((field) => [
                field.id,
                availableIndexes.get(
                  field.localized ? `${language}:${field.id}` : field.id,
                ) ?? new Map<string, Set<string>>(),
              ]),
          ),
        ).map((message) => `${language}: ${message}`),
      );
    }
  return errors;
}
export function createCmsUniqueIndex(
  collection: ContentCollection,
): Map<string, Map<string, Set<string>>> {
  const result = new Map<string, Map<string, Set<string>>>();
  const languages = [
    ...new Set(
      collection.records.flatMap((item) =>
        Object.keys(item.translations ?? {}),
      ),
    ),
  ];
  for (const field of collection.schema ?? [])
    if (field.unique) {
      const values = new Map<string, Set<string>>();
      for (const item of collection.records) {
        const key = JSON.stringify(item.values?.[field.id]);
        const ids = values.get(key) ?? new Set<string>();
        ids.add(item.id);
        values.set(key, ids);
      }
      result.set(field.id, values);
      if (field.localized)
        for (const language of languages) {
          const translatedValues = new Map<string, Set<string>>();
          for (const item of collection.records) {
            const key = JSON.stringify(
                item.translations?.[language]?.values?.[field.id] ??
                  item.values?.[field.id],
              ),
              ids = translatedValues.get(key) ?? new Set<string>();
            ids.add(item.id);
            translatedValues.set(key, ids);
          }
          result.set(`${language}:${field.id}`, translatedValues);
        }
    }
  return result;
}
export function publicContentRecord(
  collection: ContentCollection,
  value: ContentRecord,
  project?: Project,
  member = false,
  publishedSchema?: CmsFieldDefinition[],
): ContentRecord {
  publishedSchema ??= value.publication?.schema;
  value = publicationRecord(value);
  const publicIds = new Set(
    collection.schema
      ?.filter(
        (field) =>
          field.public &&
          (!publishedSchema ||
            publishedSchema.some(
              (approved) => approved.id === field.id && approved.public,
            )),
      )
      .map((field) => field.id),
  );
  const result: ContentRecord = {
    ...value,
    ...(value.values
      ? {
          values: Object.fromEntries(
            Object.entries(value.values).filter(([id]) => publicIds.has(id)),
          ),
        }
      : {}),
    fields: collection.schema
      ? Object.fromEntries(
          Object.entries(value.fields).filter(([id]) => publicIds.has(id)),
        )
      : value.fields,
  };
  if (result.translations)
    result.translations = Object.fromEntries(
      Object.entries(result.translations).map(([language, translated]) => [
        language,
        translated
          ? {
              ...translated,
              ...(translated.values
                ? {
                    values: Object.fromEntries(
                      Object.entries(translated.values).filter(([id]) =>
                        publicIds.has(id),
                      ),
                    ),
                  }
                : {}),
            }
          : undefined,
      ]),
    );
  if (project)
    for (const field of collection.schema ?? [])
      if (field.type === "reference" && publicIds.has(field.id)) {
        const target = project.collections?.find(
            (item) => item.id === field.referenceCollectionId,
          ),
          visible = new Set(
            target && (member || target.access !== "members")
              ? target.records
                  .filter((record) =>
                    isRecordPublished(
                      record,
                      undefined,
                      !project.featurePins?.some(
                        (pin) => pin.packageId === "automade.content",
                      ),
                    ),
                  )
                  .map((record) => record.id)
              : [],
          ),
          values = [
            result.values,
            ...Object.values(result.translations ?? {}).map(
              (translation) => translation?.values,
            ),
          ].filter((item): item is Record<string, CmsValue> => Boolean(item));
        for (const entry of values) {
          const current = entry[field.id];
          if (Array.isArray(current))
            entry[field.id] = current.filter((id) => visible.has(id));
          else if (typeof current === "string" && !visible.has(current))
            delete entry[field.id];
        }
      }
  delete result.archivedValues;
  return result;
}
export interface CmsQuery {
  cursor?: string;
  slug?: string;
  language?: string;
  limit: number;
  q: string;
  sort: string;
}
export function parseCmsQuery(value: unknown): CmsQuery {
  const input =
      value instanceof URLSearchParams
        ? Object.fromEntries(value)
        : record(value),
    limit = input.limit === undefined ? 20 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ValidationError("조회 개수는 1~100개입니다.");
  const q = typeof input.q === "string" ? input.q : "",
    sort = typeof input.sort === "string" ? input.sort : "title";
  if (
    q.length > 200 ||
    !/^-?(?:title|publishedAt|[A-Za-z0-9_-]{1,100})$/.test(sort)
  )
    throw new ValidationError("조회 조건을 확인하세요.");
  return {
    limit,
    q,
    sort,
    ...(input.slug !== undefined ? { slug: identifier(input.slug) } : {}),
    ...(input.language !== undefined
      ? { language: normalizeLanguage(input.language) }
      : {}),
    ...(input.cursor ? { cursor: identifier(input.cursor) } : {}),
  };
}
export function queryCollection(
  project: Project,
  id: string,
  input: unknown,
  options: { member: boolean; now?: string },
): CmsQueryResult {
  const query = parseCmsQuery(input);
  const localized = query.language
    ? localizeProject(project, query.language)
    : project;
  const collection = localized.collections?.find(
    (candidate) => candidate.id === id,
  );
  if (!collection || (collection.access === "members" && !options.member))
    throw new ValidationError("콘텐츠를 조회할 권한이 없습니다.");
  const key = query.sort.replace(/^-/, ""),
    field = collection.schema?.find((field) => field.id === key);
  if (!["title", "publishedAt"].includes(key) && (!field || !field.public))
    throw new ValidationError("공개 필드로만 정렬할 수 있습니다.");
  const filtered = collection.records
    .filter((item) =>
      isRecordPublished(
        item,
        options.now,
        !project.featurePins?.some(
          (pin) => pin.packageId === "automade.content",
        ),
      ),
    )
    .map((item) =>
      publicContentRecord(collection, item, localized, options.member),
    )
    .filter((item) => !query.slug || item.slug === query.slug)
    .filter(
      (item) =>
        !query.q ||
        [item.title, item.body, ...Object.values(item.values ?? {})]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query.q.toLocaleLowerCase()),
    );
  filtered.sort((a, b) => {
    const left =
        key === "title"
          ? a.title
          : key === "publishedAt"
            ? a.publishedAt
            : a.values?.[key],
      right =
        key === "title"
          ? b.title
          : key === "publishedAt"
            ? b.publishedAt
            : b.values?.[key];
    const result =
      typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left ?? "").localeCompare(String(right ?? ""));
    return (
      (query.sort.startsWith("-") ? -result : result) ||
      a.id.localeCompare(b.id)
    );
  });
  const position = query.cursor
    ? filtered.findIndex((item) => item.id === query.cursor)
    : -1;
  if (query.cursor && position < 0)
    throw new ValidationError(
      "조회 커서가 만료되었습니다. 처음부터 다시 조회하세요.",
    );
  const records = filtered.slice(position + 1, position + 1 + query.limit),
    hasMore = position + 1 + records.length < filtered.length;
  return {
    records,
    nextCursor: hasMore ? records.at(-1)!.id : null,
    total: filtered.length,
    schemaRevision: collection.schemaRevision ?? 0,
  };
}
export function transitionContent(
  record: ContentRecord,
  state: ContentWorkflow["state"],
  publishAt?: string,
): ContentRecord {
  const next = structuredClone(record),
    revision = next.contentRevision ?? 0;
  if (state === "approved" && next.workflow?.state !== "review")
    throw new ValidationError("검토 요청 후 승인할 수 있습니다.");
  if (
    ["published", "scheduled"].includes(state) &&
    next.workflow?.approvedRevision !== revision
  )
    throw new ValidationError("현재 내용의 승인이 필요합니다.");
  next.workflow = parseContentWorkflow({
    state,
    ...(publishAt ? { publishAt } : {}),
    ...(state === "approved"
      ? { approvedRevision: revision }
      : next.workflow?.approvedRevision === revision
        ? { approvedRevision: revision }
        : {}),
  });
  next.status = state === "published" ? "published" : "draft";
  return next;
}
export function editContentRecord(
  record: ContentRecord,
  patch: Partial<
    Pick<
      ContentRecord,
      | "title"
      | "body"
      | "category"
      | "imageId"
      | "fields"
      | "values"
      | "translations"
    >
  >,
): ContentRecord {
  return {
    ...structuredClone(record),
    ...structuredClone(patch),
    contentRevision: (record.contentRevision ?? 0) + 1,
    status: "draft",
    workflow: { state: "draft" },
  };
}
export interface SchemaChangePreview {
  project: Project;
  changes: {
    recordId: string;
    fieldId: string;
    action: "archive" | "restore";
  }[];
  errors: string[];
}
export function previewSchemaChange(
  project: Project,
  collectionId: string,
  input: unknown,
): SchemaChangePreview {
  const schema = parseCmsSchema(input),
    next = structuredClone(project),
    collection = next.collections?.find((item) => item.id === collectionId);
  if (!collection) throw new ValidationError("변경할 컬렉션이 없습니다.");
  const changes: SchemaChangePreview["changes"] = [],
    allowed = new Set(schema.map((field) => field.id));
  for (const record of collection.records) {
    for (const [key, value] of Object.entries(record.values ?? {}))
      if (!allowed.has(key)) {
        record.archivedValues ??= {};
        record.archivedValues[key] = value;
        delete record.values![key];
        changes.push({ recordId: record.id, fieldId: key, action: "archive" });
      }
    for (const [key, value] of Object.entries(record.archivedValues ?? {}))
      if (allowed.has(key) && record.values?.[key] === undefined) {
        record.values ??= {};
        record.values[key] = value;
        delete record.archivedValues![key];
        changes.push({ recordId: record.id, fieldId: key, action: "restore" });
      }
  }
  collection.schema = schema;
  collection.schemaRevision = (collection.schemaRevision ?? 0) + 1;
  const errors = collection.records.flatMap((record) =>
    validateCmsRecord(next, collection, record).map(
      (message) => `${record.title}: ${message}`,
    ),
  );
  return { project: next, changes, errors };
}
/** Runtime CMS writes use this snapshot without changing the pinned release document. */
export function withCmsSnapshot(project: Project, value: unknown): Project {
  if (value === undefined || value === null) return structuredClone(project);
  const input = record(value);
  if (
    !Number.isSafeInteger(input.revision) ||
    Number(input.revision) < 0 ||
    !Array.isArray(input.collections)
  )
    throw new ValidationError("CMS 저장 스냅샷 형식을 확인하세요.");
  return parseProject({ ...project, collections: input.collections });
}
