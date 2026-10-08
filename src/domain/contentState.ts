import type { ContentRecord, Project } from "./types";
import type { TranslationReview } from "./contentContracts";
import { parseCmsSchema, parseCmsValues, parseContentWorkflow } from "./cms";
import { normalizeLanguage } from "./languages";
import { record, ValidationError } from "./validation";

const text = (value: unknown, max: number): string => {
  if (typeof value !== "string" || value.length > max)
    throw new ValidationError("콘텐츠 메타데이터 문자열을 확인하세요.");
  return value;
};
const revision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new ValidationError("콘텐츠 버전을 확인하세요.");
  return Number(value);
};
const safeKey = (key: string): string => {
  if (
    !/^[A-Za-z0-9_:.-]{1,200}$/.test(key) ||
    ["__proto__", "prototype", "constructor"].includes(key)
  )
    throw new ValidationError("콘텐츠 변경 경로를 확인하세요.");
  return key;
};
export function parseRevisionMap(value: unknown): Record<string, number> {
  const entries = Object.entries(record(value));
  if (entries.length > 500)
    throw new ValidationError("콘텐츠 변경 경로가 너무 많습니다.");
  return Object.fromEntries(
    entries.map(([key, value]) => [safeKey(key), revision(value)]),
  );
}
export function parseTranslationReviews(
  value: unknown,
): Record<string, TranslationReview> {
  const entries = Object.entries(record(value));
  if (entries.length > 30)
    throw new ValidationError("번역 검토 언어가 너무 많습니다.");
  return Object.fromEntries(
    entries.map(([language, value]) => {
      const item = record(value),
        hashes = Object.entries(record(item.sourceFieldHashes));
      if (
        !["draft", "review", "approved", "stale"].includes(
          String(item.state),
        ) ||
        !Array.isArray(item.changedFields) ||
        item.changedFields.length > 500 ||
        hashes.length > 500
      )
        throw new ValidationError("번역 검토 상태를 확인하세요.");
      const result: TranslationReview = {
        sourceRevision: revision(item.sourceRevision),
        sourceFieldHashes: Object.fromEntries(
          hashes.map(([key, value]) => [safeKey(key), text(value, 200)]),
        ),
        changedFields: item.changedFields.map((field) =>
          safeKey(text(field, 200)),
        ),
        state: item.state as TranslationReview["state"],
      };
      if (item.assignee !== undefined)
        result.assignee = text(item.assignee, 100);
      if (item.reviewer !== undefined)
        result.reviewer = text(item.reviewer, 100);
      if (item.glossaryVersion !== undefined)
        result.glossaryVersion = revision(item.glossaryVersion);
      return [normalizeLanguage(language), result];
    }),
  );
}
export function enrichContentState(
  item: ContentRecord,
  input: Record<string, unknown>,
): void {
  if (input.fieldRevisions !== undefined)
    item.fieldRevisions = parseRevisionMap(input.fieldRevisions);
  if (input.languageRevisions !== undefined)
    item.languageRevisions = parseRevisionMap(input.languageRevisions);
  if (input.translationReviews !== undefined)
    item.translationReviews = parseTranslationReviews(input.translationReviews);
  if (input.localizedSlugs !== undefined)
    item.localizedSlugs = Object.fromEntries(
      Object.entries(record(input.localizedSlugs)).map(([language, value]) => {
        const slug = text(value, 100);
        if (!/^[A-Za-z0-9_-]+$/.test(slug))
          throw new ValidationError("언어별 콘텐츠 주소를 확인하세요.");
        return [normalizeLanguage(language), slug];
      }),
    );
  if (input.addressHistory !== undefined) {
    if (
      !Array.isArray(input.addressHistory) ||
      input.addressHistory.length > 1000
    )
      throw new ValidationError("콘텐츠 주소 이력을 확인하세요.");
    item.addressHistory = input.addressHistory.map((value) => {
      const entry = record(value),
        path = text(entry.path, 400);
      if (!/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(path))
        throw new ValidationError("이전 콘텐츠 주소를 확인하세요.");
      return {
        path,
        language: normalizeLanguage(entry.language),
        sequence: revision(entry.sequence),
      };
    });
  }
  if (input.publication !== undefined) {
    const published = record(input.publication),
      source = record(published.record);
    if (
      source.publication !== undefined ||
      source.id !== item.id ||
      source.status !== "published"
    )
      throw new ValidationError("불변 발행본을 확인하세요.");
    const slug = text(source.slug, 100),
      fields = Object.entries(record(source.fields));
    if (!/^[A-Za-z0-9_-]+$/.test(slug) || fields.length > 100)
      throw new ValidationError("불변 발행본 주소·필드를 확인하세요.");
    const snapshot: ContentRecord = {
      id: item.id,
      slug,
      title: text(source.title, 1000),
      body: text(source.body, 50000),
      category: text(source.category, 200),
      imageId: text(source.imageId, 100),
      status: "published",
      publishedAt: text(source.publishedAt, 100),
      fields: Object.fromEntries(
        fields.map(([key, value]) => [safeKey(key), text(value, 10000)]),
      ),
      contentRevision: revision(published.revision),
    };
    if (!Number.isFinite(Date.parse(snapshot.publishedAt)))
      throw new ValidationError("불변 발행본 시각을 확인하세요.");
    if (source.values !== undefined)
      snapshot.values = parseCmsValues(source.values);
    if (source.workflow !== undefined)
      snapshot.workflow = parseContentWorkflow(source.workflow);
    if (
      snapshot.workflow &&
      (snapshot.workflow.state !== "published" ||
        snapshot.workflow.approvedRevision !== snapshot.contentRevision)
    )
      throw new ValidationError("불변 발행본 승인을 확인하세요.");
    if (source.translations !== undefined)
      snapshot.translations = Object.fromEntries(
        Object.entries(record(source.translations)).map(([locale, value]) => {
          const translation = record(value);
          return [
            normalizeLanguage(locale),
            {
              title: text(translation.title, 1000),
              body: text(translation.body, 50000),
              ...(translation.values !== undefined
                ? { values: parseCmsValues(translation.values) }
                : {}),
            },
          ];
        }),
      );
    enrichContentState(snapshot, {
      ...(source.localizedSlugs === undefined
        ? {}
        : { localizedSlugs: source.localizedSlugs }),
      ...(source.addressHistory === undefined
        ? {}
        : { addressHistory: source.addressHistory }),
    });
    item.publication = {
      revision: revision(published.revision),
      sequence: revision(published.sequence),
      publishedAt: text(published.publishedAt, 100),
      schemaRevision: revision(published.schemaRevision),
      schema: parseCmsSchema(published.schema),
      record: snapshot,
    };
  }
}
/** Public rendering always chooses the last immutable approved version, never the working copy. */
export function publicationRecord(item: ContentRecord): ContentRecord {
  const result: ContentRecord = structuredClone(
    item.publication?.record ?? item,
  );
  delete result.publication;
  delete result.translationReviews;
  delete result.fieldRevisions;
  delete result.languageRevisions;
  return result;
}
export function contentSourceFields(
  item: ContentRecord,
): Record<string, string> {
  const fields: [string, string][] = [
    "title",
    "body",
    "category",
    "imageId",
    "slug",
  ].map((key) => [key, JSON.stringify(item[key as keyof ContentRecord])]);
  fields.push(
    ...Object.entries(item.values ?? {}).map(
      ([key, value]): [string, string] => [
        `values:${key}`,
        JSON.stringify(value),
      ],
    ),
  );
  fields.push(
    ...Object.entries(item.fields).map(([key, value]): [string, string] => [
      `fields:${key}`,
      JSON.stringify(value),
    ]),
  );
  return Object.fromEntries(fields);
}
export function translationFieldsChanged(
  before: ContentRecord,
  after: ContentRecord,
): string[] {
  const a = contentSourceFields(before),
    b = contentSourceFields(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (key) => a[key] !== b[key],
  );
}
export function localeCoverage(
  project: Project,
  item: ContentRecord,
  language: string,
): { missing: string[]; stale: string[]; fallback: string[] } {
  const translated = item.translations?.[language],
    fields = [
      "title",
      "body",
      ...(project.collections
        ?.find((collection) =>
          collection.records.some((record) => record.id === item.id),
        )
        ?.schema?.filter((field) => field.localized)
        .map((field) => `values:${field.id}`) ?? []),
    ];
  const missing = fields.filter((field) =>
    field.startsWith("values:")
      ? translated?.values?.[field.slice(7)] === undefined
      : !translated?.[field as "title" | "body"],
  );
  return {
    missing,
    stale: item.translationReviews?.[language]?.changedFields ?? [],
    fallback: missing,
  };
}
