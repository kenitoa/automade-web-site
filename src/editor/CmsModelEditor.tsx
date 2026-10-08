import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import type {
  CmsFieldDefinition,
  ContentCollection,
  Project,
} from "../domain/types";
import type { ContentMigrationPlan } from "../domain/contentContracts";
import { parseCmsSchema } from "../domain/cms";
import { parseProject } from "../domain/validation";
import { api } from "../infrastructure/api";
import { panelViewKey } from "../infrastructure/panelViewState";
import {
  readCmsMigrationReceipt,
  saveCmsMigrationReceipt,
  clearCmsMigrationReceipt,
  type CmsMigrationReceipt,
} from "../infrastructure/cmsMigrationReceipt";
import type { StudioState } from "./useStudio";
import type { ExpansionState } from "./useExpansion";
import { systemEndpoint } from "./useSystemActions";
import EditorDialog from "./EditorDialog";
export default function CmsModelEditor({
  collection,
  studio: s,
  expansion: x,
}: {
  collection: ContentCollection;
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const receiptKey =
    panelViewKey(s.project.id, x.environmentId, `cms-model-${collection.id}`) +
    ":migration";
  const [initialReceipt] = useState(() => {
    try {
      return { receipt: readCmsMigrationReceipt(receiptKey), error: "" };
    } catch (e) {
      return {
        receipt: null,
        error:
          e instanceof Error
            ? e.message
            : "기기 이전 작업 보관 정보를 확인하세요.",
      };
    }
  });
  const [schema, setSchema] = useState<CmsFieldDefinition[]>(
      structuredClone(collection.schema || []),
    ),
    [error, setError] = useState(initialReceipt.error),
    [resume, setResume] = useState<CmsMigrationReceipt | null>(
      initialReceipt.receipt,
    ),
    [preview, setPreview] = useState<ContentMigrationPlan | null>(null),
    [reviewRevision, setReviewRevision] = useState(0),
    [busy, setBusy] = useState(false);
  const current = useRef(""),
    latestStudio = useRef(s);
  current.current = `${x.session.account?.id || "local"}/${s.project.id}/${x.environmentId}/${collection.id}`;
  latestStudio.current = s;
  const canEdit = s.editable && x.can("project.edit") && Boolean(x.scope);
  function checkPlan(plan: ContentMigrationPlan): ContentMigrationPlan {
    if (
      !plan ||
      typeof plan.id !== "string" ||
      plan.collectionId !== collection.id ||
      !["preview", "running", "blocked", "complete", "cancelled"].includes(
        plan.state,
      ) ||
      !Number.isInteger(plan.sourceSchemaRevision) ||
      !Number.isInteger(plan.processed) ||
      !Array.isArray(plan.errors) ||
      (plan.preview && !Number.isInteger(plan.preview.records))
    )
      throw new Error("콘텐츠 모델 이전 응답을 확인하세요.");
    return { ...plan, targetSchema: parseCmsSchema(plan.targetSchema) };
  }
  const patch = (i: number, change: Partial<CmsFieldDefinition>) => {
    setSchema(
      schema.map((field, index) =>
        index === i ? { ...field, ...change } : field,
      ),
    );
    setPreview(null);
  };
  async function inspect() {
    const scope = current.current,
      project = s.project,
      endpoint = systemEndpoint(
        `models/${encodeURIComponent(collection.id)}/preview`,
        project.id,
        x.environmentId,
      );
    setBusy(true);
    setError("");
    try {
      const parsed = parseCmsSchema(schema);
      if (!(await s.syncProject(project)))
        throw new Error("모델 검토 전에 문서 동기화를 완료하세요.");
      if (current.current !== scope) return;
      const revision = latestStudio.current.project.revision;
      const plan = checkPlan(
        await api<ContentMigrationPlan>(endpoint, "POST", { schema: parsed }),
      );
      if (current.current !== scope) return;
      setPreview(plan);
      setReviewRevision(revision);
    } catch (e) {
      if (current.current === scope)
        setError(e instanceof Error ? e.message : "모델을 확인하세요.");
    } finally {
      if (current.current === scope) setBusy(false);
    }
  }
  async function runBatch() {
    if (!preview) return;
    const scope = current.current,
      projectId = s.project.id,
      environmentId = x.environmentId,
      revision = reviewRevision;
    setBusy(true);
    setError("");
    try {
      if (latestStudio.current.project.revision !== revision)
        throw new Error(
          "검토 이후 문서가 변경되었습니다. 최신 자료로 다시 검토하세요.",
        );
      try {
        const receipt = { plan: preview, reviewRevision: revision };
        saveCmsMigrationReceipt(receiptKey, receipt);
        setResume(receipt);
      } catch (e) {
        setError(
          `서버 작업은 보존됩니다. 기기 재개 정보 보관 실패: ${e instanceof Error ? e.message : "브라우저 저장소 확인"} · 작업 ${preview.id}`,
        );
      }
      const plan = checkPlan(
        await api<ContentMigrationPlan>(
          systemEndpoint(
            `models/${encodeURIComponent(preview.id)}/run`,
            projectId,
            environmentId,
          ),
          "POST",
          { limit: 100 },
        ),
      );
      if (current.current !== scope) return;
      setPreview(plan);
      if (plan.state === "running" || plan.state === "complete") {
        try {
          const receipt = { plan, reviewRevision: revision };
          saveCmsMigrationReceipt(receiptKey, receipt);
          setResume(receipt);
        } catch (e) {
          setError(
            `서버 작업 ${plan.id}의 기기 재개 정보 확인: ${e instanceof Error ? e.message : "브라우저 저장소 확인"}`,
          );
        }
      }
      if (plan.state === "complete") {
        const canonical = parseProject(
          await api<Project>(
            `/api/projects/${encodeURIComponent(projectId)}?environmentId=${encodeURIComponent(environmentId)}`,
          ),
        );
        if (current.current !== scope) return;
        await latestStudio.current.acceptServerProject(canonical, revision);
        clearCmsMigrationReceipt(receiptKey);
        setResume(null);
        setPreview(null);
        s.setMessage(
          "서버에서 콘텐츠 모델·자료 이전을 완료했습니다. 공개본은 별도 검토·발행 상태를 유지합니다.",
        );
      }
    } catch (e) {
      if (current.current === scope)
        setError(
          e instanceof Error ? e.message : "모델 이전을 완료하지 못했습니다.",
        );
    } finally {
      if (current.current === scope) setBusy(false);
    }
  }
  async function resumeReview() {
    if (!resume) return;
    const scope = current.current,
      project = s.project;
    setBusy(true);
    setError("");
    try {
      const plan = checkPlan(resume.plan);
      if (!(await s.syncProject(project)))
        throw new Error("재개 검토 전에 현재 기기 변경의 동기화를 완료하세요.");
      if (current.current !== scope) return;
      // Commit queued canonical state before capturing the resumed review revision.
      flushSync(() => {
        setPreview(plan);
        setSchema(plan.targetSchema);
      });
      setReviewRevision(latestStudio.current.project.revision);
    } catch (e) {
      if (current.current === scope)
        setError(
          e instanceof Error ? e.message : "보관한 이전 작업을 확인하세요.",
        );
    } finally {
      if (current.current === scope) setBusy(false);
    }
  }
  return (
    <details>
      <summary>타입 콘텐츠 모델·관계</summary>
      <p className="hint">
        필드 ID는 자료 연결 기준입니다. 기존 값과 관계를 검증한 뒤 모델을
        서버에서 최대 100건씩 후보를 만들고 모두 검증된 뒤 한 번에 적용합니다.
        공개 필드만 사이트에 제공하며 기존 발행본은 보존합니다.
      </p>
      {schema.map((field, i) => (
        <fieldset
          key={i}
          disabled={busy || !canEdit || preview?.state === "running"}
        >
          <legend>{field.label || `필드 ${i + 1}`}</legend>
          <label>
            필드 ID
            <input
              value={field.id}
              onChange={(e) => patch(i, { id: e.target.value })}
              maxLength={100}
            />
          </label>
          <label>
            필드 이름
            <input
              value={field.label}
              onChange={(e) => patch(i, { label: e.target.value })}
              maxLength={200}
            />
          </label>
          <label>
            값 형식
            <select
              value={field.type}
              onChange={(e) =>
                patch(i, { type: e.target.value as CmsFieldDefinition["type"] })
              }
            >
              {[
                ["text", "텍스트"],
                ["number", "숫자"],
                ["boolean", "참/거짓"],
                ["date", "날짜"],
                ["enum", "선택"],
                ["image", "이미지"],
                ["reference", "콘텐츠 관계"],
              ].map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {field.type === "enum" && (
            <label>
              선택값 (한 줄에 하나)
              <textarea
                value={field.options?.join("\n") || ""}
                onChange={(e) =>
                  patch(i, {
                    options: e.target.value
                      .split("\n")
                      .map((v) => v.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
          )}
          {field.type === "reference" && (
            <label>
              연결 컬렉션
              <select
                value={field.referenceCollectionId || ""}
                onChange={(e) =>
                  patch(i, { referenceCollectionId: e.target.value })
                }
              >
                <option value="">컬렉션 선택</option>
                {s.project.collections?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(
            ["required", "unique", "public", "readOnly", "localized"] as const
          ).map((key) => (
            <label className="check" key={key}>
              <input
                type="checkbox"
                checked={Boolean(field[key])}
                onChange={(e) => patch(i, { [key]: e.target.checked })}
              />
              {
                {
                  required: "필수",
                  unique: "고유값",
                  public: "공개 사이트 제공",
                  readOnly: "자료 입력 후 읽기 전용",
                  localized: "언어별 검토 필요",
                }[key]
              }
            </label>
          ))}
          {["text", "number"].includes(field.type) && (
            <div className="two-col">
              {(["min", "max"] as const).map((key) => (
                <label key={key}>
                  {key === "min" ? "최소" : "최대"}
                  <input
                    type="number"
                    value={field[key] ?? ""}
                    onChange={(e) =>
                      patch(i, {
                        [key]:
                          e.target.value === ""
                            ? undefined
                            : Number(e.target.value),
                      })
                    }
                  />
                </label>
              ))}
            </div>
          )}
          <button
            type="button"
            className="danger"
            onClick={() => {
              setSchema(schema.filter((_, index) => index !== i));
              setPreview(null);
            }}
          >
            필드 제거안 만들기
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        disabled={busy || !canEdit || preview?.state === "running"}
        onClick={() => {
          setSchema([
            ...schema,
            {
              id: `field_${schema.length + 1}`,
              label: "새 필드",
              type: "text",
              public: false,
            },
          ]);
          setPreview(null);
        }}
      >
        모델 필드 추가
      </button>
      <button
        type="button"
        disabled={busy || !canEdit}
        onClick={() => void inspect()}
      >
        기존 자료 영향 검토
      </button>
      {busy && <p role="status">서버의 콘텐츠 모델·이전 상태 확인 중…</p>}
      {resume && !preview && (
        <div>
          <p>
            보관한 서버 이전 작업 {resume.plan.id} · 후보{" "}
            {resume.plan.processed}건. 재개 검토 전에 현재 기기 변경을
            동기화하고 서버가 원본·권한·checkpoint를 다시 확인합니다.
          </p>
          <button
            type="button"
            disabled={busy || !canEdit}
            onClick={() => void resumeReview()}
          >
            보관한 모델 이전 재개 검토
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="bad" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </p>
      )}
      {preview && (
        <EditorDialog
          title="콘텐츠 모델 변경 검토"
          onClose={() => {
            if (!busy) setPreview(null);
          }}
        >
          <p>
            {collection.name}: 필드 {collection.schema?.length || 0} →{" "}
            {preview.targetSchema.length}개, 서버 자료{" "}
            {preview.preview?.records ?? collection.records.length}개 검토, 값
            변환 {preview.preview?.changes ?? preview.changes}개, 오류 자료{" "}
            {preview.preview?.invalidRecords ?? preview.errors.length}개
          </p>
          <p>
            제거 필드{" "}
            {collection.schema
              ?.filter(
                (old) =>
                  !preview.targetSchema.some((field) => field.id === old.id),
              )
              .map((field) => field.label)
              .join(", ") || "없음"}
            . 자료의 기존 값은 자동 삭제하지 않습니다.
          </p>
          <table className="change-table">
            <thead>
              <tr>
                <th>필드</th>
                <th>형식</th>
                <th>공개</th>
                <th>필수</th>
              </tr>
            </thead>
            <tbody>
              {preview.targetSchema.map((field) => (
                <tr key={field.id}>
                  <td>
                    {field.label} ({field.id})
                  </td>
                  <td>{field.type}</td>
                  <td>{field.public ? "제공" : "내부"}</td>
                  <td>{field.required ? "필수" : "선택"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p role="status">
            이전 상태 {preview.state} · 후보 검증 {preview.processed}건 · 작업{" "}
            {preview.id}
          </p>
          <p>
            각 배치의 결과는 서버에 보관됩니다. 자료·모델이 바뀌면 적용을
            보류하고 새 검토를 요청합니다.
          </p>
          <p>
            검토 문서 v{reviewRevision} · 현재 문서 v{s.project.revision}
          </p>
          {s.project.revision !== reviewRevision && resume && (
            <div>
              <p role="alert">
                검토 후 원본이 달라졌습니다. 현재 원본을 동기화하고 같은 서버
                이전 작업을 다시 검토하세요.
              </p>
              <button
                type="button"
                disabled={busy || !canEdit}
                onClick={() => void resumeReview()}
              >
                최신 원본으로 이전 재개 검토
              </button>
            </div>
          )}
          {(preview.errors.length
            ? preview.errors
            : preview.preview?.errors || []
          )
            .slice(0, 20)
            .map((item) => (
              <p className="bad" key={item.recordId}>
                {item.recordId}: {item.errors.join(", ")}
              </p>
            ))}
          {error && (
            <p role="alert" className="bad">
              {error}
            </p>
          )}
          <button
            type="button"
            className="primary"
            disabled={
              busy ||
              !canEdit ||
              s.project.revision !== reviewRevision ||
              preview.state === "blocked" ||
              preview.state === "cancelled" ||
              Boolean(preview.preview?.invalidRecords)
            }
            onClick={() => void runBatch()}
          >
            {preview.state === "running"
              ? "다음 100건 검증·이전 계속"
              : "검토한 모델 적용"}
          </button>
        </EditorDialog>
      )}
    </details>
  );
}
