import type {
  ContentCollection,
  ContentRecord,
  CmsValue,
} from "../domain/types";
import { validateCmsRecord } from "../domain/cms";
import { parseProject } from "../domain/validation";
import { useState } from "react";
import type { StudioState } from "./useStudio";
export default function CmsRecordValues({
  studio: s,
  collection,
  record,
  patch,
  expansion: x,
}: {
  studio: StudioState;
  expansion: import("./useExpansion").ExpansionState;
  collection: ContentCollection;
  record: ContentRecord;
  patch: (
    change: (record: ContentRecord) => void,
    contentChange?: boolean,
  ) => void;
}) {
  const [schedule, setSchedule] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const update = (id: string, value: CmsValue) =>
    patch((r) => {
      r.values ??= {};
      r.values[id] = value;
    });
  async function transition(
    state: NonNullable<ContentRecord["workflow"]>["state"],
  ) {
    setBusy(true);
    try {
      const errors = validateCmsRecord(s.project, collection, record);
      if (
        ["review", "approved", "scheduled", "published"].includes(state) &&
        errors.length
      )
        throw new Error(errors.join("\n"));
      if (!(await s.syncProject(s.project)))
        throw new Error(
          "원본 변경을 서버에 동기화한 뒤 발행 상태를 저장하세요.",
        );
      const result = await x.request<{
        project: unknown;
        job?: { id: string };
      }>("cms/transitions", "POST", {
        projectId: s.project.id,
        collectionId: collection.id,
        recordId: record.id,
        baseRevision: s.project.revision,
        state,
        ...(state === "scheduled"
          ? { publishAt: new Date(schedule).toISOString() }
          : {}),
      });
      await s.acceptServerProject(
        parseProject(result.project),
        s.project.revision,
      );
      s.setMessage(
        result.job
          ? `콘텐츠 실행 작업 ${result.job.id}을 저장했습니다. 실행 상태는 운영 대기열에서 확인하세요.`
          : "콘텐츠의 서버 검토·발행 상태를 저장했습니다.",
      );
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "발행 상태를 확인하세요.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <details open={Boolean(collection.schema?.length)}>
        <summary>모델 자료 입력</summary>
        {collection.schema?.map((field) => {
          const value = record.values?.[field.id];
          return (
            <label key={field.id}>
              {field.label}
              {field.required ? " *" : ""} {field.public ? "· 공개" : "· 내부"}
              {field.type === "boolean" ? (
                <select
                  disabled={Boolean(
                    field.readOnly && value !== undefined && value !== null,
                  )}
                  value={
                    value === true ? "true" : value === false ? "false" : ""
                  }
                  onChange={(e) =>
                    update(
                      field.id,
                      e.target.value === "" ? null : e.target.value === "true",
                    )
                  }
                >
                  <option value="">미설정</option>
                  <option value="true">예</option>
                  <option value="false">아니요</option>
                </select>
              ) : field.type === "enum" ||
                field.type === "image" ||
                field.type === "reference" ? (
                <select
                  disabled={Boolean(
                    field.readOnly && value !== undefined && value !== null,
                  )}
                  value={typeof value === "string" ? value : ""}
                  onChange={(e) => update(field.id, e.target.value)}
                >
                  <option value="">미선택</option>
                  {field.type === "enum"
                    ? field.options?.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))
                    : field.type === "image"
                      ? s.project.assets.map((asset) => (
                          <option key={asset.id} value={asset.id}>
                            {asset.name}
                          </option>
                        ))
                      : s.project.collections
                          ?.find((c) => c.id === field.referenceCollectionId)
                          ?.records.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.title}
                            </option>
                          ))}
                </select>
              ) : (
                <input
                  disabled={Boolean(
                    field.readOnly && value !== undefined && value !== null,
                  )}
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
                  min={field.type === "number" ? field.min : undefined}
                  max={field.type === "number" ? field.max : undefined}
                  onChange={(e) =>
                    update(
                      field.id,
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
        {!collection.schema?.length && (
          <p>콘텐츠 모델에서 타입 필드를 정의하세요.</p>
        )}
        {validateCmsRecord(s.project, collection, record).map((message, i) => (
          <p className="bad" key={i}>
            {message}
          </p>
        ))}
      </details>
      <details>
        <summary>자료 검토·발행 상태</summary>
        <p>
          현재 {record.workflow?.state || record.status} · 내용 v
          {record.contentRevision || 0} · 승인 v
          {record.workflow?.approvedRevision ?? "미승인"}
        </p>
        <div className="button-row">
          {[
            ["draft", "초안"],
            ["review", "검토 요청"],
            ["approved", "현재 내용 승인"],
            ["published", "승인 내용 발행"],
            ["archived", "보관"],
          ].map(([state, label]) => (
            <button
              type="button"
              key={state}
              disabled={
                busy ||
                !x.can(
                  state === "approved"
                    ? "review.approve"
                    : state === "published"
                      ? "project.publish"
                      : "project.edit",
                )
              }
              onClick={() =>
                void transition(
                  state as NonNullable<ContentRecord["workflow"]>["state"],
                )
              }
            >
              {label}
            </button>
          ))}
        </div>
        <label>
          예약 발행 시각
          <input
            type="datetime-local"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={!schedule || busy || !x.can("project.publish")}
          onClick={() => void transition("scheduled")}
        >
          현재 승인 내용 예약
        </button>
        <p className="hint">
          내용을 수정하면 승인과 예약을 다시 검토해야 합니다. 실행 사이트의 자료
          발행은 운영의 콘텐츠 실행 대기열에서 처리합니다.
        </p>
        {error && (
          <p role="alert" className="bad" style={{ whiteSpace: "pre-wrap" }}>
            {error}
          </p>
        )}
      </details>
    </>
  );
}
