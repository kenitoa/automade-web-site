import type {
  CmsValue,
  ContentCollection,
  ContentRecord,
} from "../domain/types";
import type { StudioState } from "./useStudio";
export default function CmsLocalizedFields({
  studio: s,
  collection,
  record,
  language,
  patch,
}: {
  studio: StudioState;
  collection: ContentCollection;
  record: ContentRecord;
  language: string;
  patch: (change: (record: ContentRecord) => void) => void;
}) {
  return (
    <>
      {collection.schema
        ?.filter((field) => field.localized)
        .map((field) => {
          const value = record.translations?.[language]?.values?.[field.id],
            disabled = Boolean(
              field.readOnly && value !== undefined && value !== null,
            ),
            update = (value: CmsValue) =>
              patch((r) => {
                r.translations ??= {};
                r.translations[language] ??= { title: "", body: "" };
                r.translations[language]!.values ??= {};
                r.translations[language]!.values![field.id] = value;
              });
          return (
            <label key={field.id}>
              {field.label} · 언어별 자료{field.public ? " · 공개" : " · 내부"}
              {["boolean", "enum", "image", "reference"].includes(
                field.type,
              ) ? (
                <select
                  disabled={disabled}
                  value={
                    value === true
                      ? "true"
                      : value === false
                        ? "false"
                        : typeof value === "string"
                          ? value
                          : ""
                  }
                  onChange={(e) =>
                    update(
                      field.type === "boolean"
                        ? e.target.value === ""
                          ? null
                          : e.target.value === "true"
                        : e.target.value,
                    )
                  }
                >
                  <option value="">원문·대체 언어 사용</option>
                  {field.type === "boolean" ? (
                    <>
                      <option value="true">예</option>
                      <option value="false">아니요</option>
                    </>
                  ) : field.type === "enum" ? (
                    field.options?.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))
                  ) : field.type === "image" ? (
                    s.project.assets.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.name}
                      </option>
                    ))
                  ) : (
                    s.project.collections
                      ?.find((c) => c.id === field.referenceCollectionId)
                      ?.records.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.title}
                        </option>
                      ))
                  )}
                </select>
              ) : (
                <input
                  disabled={disabled}
                  type={
                    field.type === "number"
                      ? "number"
                      : field.type === "date"
                        ? "date"
                        : "text"
                  }
                  value={
                    typeof value === "string" || typeof value === "number"
                      ? value
                      : ""
                  }
                  placeholder={String(record.values?.[field.id] ?? "")}
                  min={field.type === "number" ? field.min : undefined}
                  max={field.type === "number" ? field.max : undefined}
                  onChange={(e) =>
                    update(
                      field.type === "number"
                        ? e.target.value === ""
                          ? null
                          : Number(e.target.value)
                        : e.target.value,
                    )
                  }
                />
              )}
            </label>
          );
        })}
    </>
  );
}
