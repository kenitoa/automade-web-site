import { lazy, Suspense, useState } from "react";
import { redo, undo } from "../domain/commands";
import EnhancedInspector from "./EnhancedInspector";
import Workspace from "./Workspace";
import ToolPanel from "./ToolPanel";
import ProjectWizard from "./ProjectWizard";
import { useStudio } from "./useStudio";
import { useGeneration } from "./useGeneration";
import CreatorGate from "./CreatorGate";
const SyncReview = lazy(() => import("./SyncReview"));
import { useExpansion } from "./useExpansion";
import ExpansionScopeBar from "./ExpansionScopeBar";
import EditorDialog from "./EditorDialog";
import { useStudioNavigation } from "./useStudioNavigation";
import { useProductExperiments } from "./useProductExperiments";
import { downloadFile } from "../infrastructure/library";
const CollaborationPanel = lazy(() => import("./CollaborationPanel"));
const DataBindingPanel = lazy(() => import("./DataBindingPanel"));
const StudioTaskInbox = lazy(() => import("./StudioTaskInbox"));
const StepUpDialog = lazy(() => import("./StepUpDialog"));
import "../runtime/site.css";
import "./studio.css";
export default function Studio() {
  return (
    <CreatorGate>
      <StudioContent />
    </CreatorGate>
  );
}
function StudioContent() {
  const s = useStudio(),
    x = useExpansion(s),
    g = useGeneration(s, x.environmentId),
    [wizard, setWizard] = useState(false);
  const navigation = useStudioNavigation(s, x);
  const experiment = useProductExperiments(s, x);
  return (
    <main
      className="studio"
      onFocusCapture={(e) => {
        const target = e.target as HTMLElement;
        if (["INPUT", "TEXTAREA"].includes(target.tagName)) s.beginEditing();
      }}
      onBlurCapture={(e) => {
        const target = e.target as HTMLElement;
        if (["INPUT", "TEXTAREA"].includes(target.tagName)) s.endEditing();
      }}
    >
      <header className="studio-top">
        <a
          className="studio-brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            s.setSelected([]);
          }}
        >
          A
          <span>
            Automade<span className="brand-sub">Website Studio</span>
          </span>
        </a>
        <div className="project-heading">
          <input
            aria-label="프로젝트 이름"
            disabled={!s.editable}
            value={s.project.name}
            onChange={(e) =>
              s.apply((p) => {
                p.name = e.target.value;
              })
            }
          />
          <span
            role="status"
            className={s.saveState.includes("실패") ? "bad" : "hint"}
          >
            {s.saveState}
          </span>
          <small
            title={
              s.lastSaved ? new Date(s.lastSaved).toLocaleString() : undefined
            }
          >
            {s.lastSaved
              ? `이 기기 저장 ${new Date(s.lastSaved).toLocaleTimeString()}`
              : "저장 대기"}{" "}
            · {s.ready ? "서버 백업 연결" : "로컬 저장"}
          </small>
          <small>{s.online ? "온라인" : "오프라인 · 변경 보관"}</small>
          {s.hasSyncConflict && (
            <button type="button" onClick={s.reviewSync}>
              서버 변경 비교
            </button>
          )}
          {s.saveState.includes("실패") || !s.ready ? (
            <button
              type="button"
              className="save-retry"
              onClick={() => void s.retrySave()}
            >
              저장·연결 재시도
            </button>
          ) : null}
        </div>
        <div className="top-actions">
          <button
            className="icon-button"
            type="button"
            disabled={!s.editable || !s.history.past.length}
            onClick={() => s.setHistory(undo)}
            title="실행 취소 (Ctrl+Z)"
            aria-label="실행 취소"
          >
            ↶
          </button>
          <button
            className="icon-button"
            type="button"
            disabled={!s.editable || !s.history.future.length}
            onClick={() => s.setHistory(redo)}
            title="다시 실행 (Ctrl+Y)"
            aria-label="다시 실행"
          >
            ↷
          </button>
          <button
            className="secondary"
            type="button"
            disabled={!x.can("project.create")}
            onClick={() => setWizard(true)}
          >
            새 프로젝트
          </button>
          <button
            type="button"
            className="inspector-toggle"
            aria-expanded={s.inspectorOpen}
            aria-controls="studio-properties"
            onClick={() => s.setInspectorOpen(!s.inspectorOpen)}
          >
            {s.inspectorOpen ? "속성 닫기" : "속성 열기"}
          </button>
          <button
            className="primary create-button"
            type="button"
            disabled={g.busy || !s.loaded || !x.can("project.publish")}
            onClick={() => void g.oneClick()}
          >
            {g.busy ? g.job?.stage || "처리 중…" : "사이트 만들고 열기 ↗"}
          </button>
        </div>
      </header>
      <ExpansionScopeBar expansion={x} />
      <div className="studio-context-status" role="status" aria-live="polite">
        {navigation.restoring
          ? "작업 위치를 복원하고 권한을 확인하고 있습니다…"
          : `기기 원본 v${s.project.revision} · ${x.bootstrap?.environments.find((env) => env.id === x.environmentId)?.name || "기본 환경"} · ${s.activePage.title}`}
        {navigation.error && <span className="bad"> · {navigation.error}</span>}
        <a
          href={navigation.link}
          onClick={(e) => {
            e.preventDefault();
            void navigator.clipboard
              .writeText(navigation.link)
              .then(() =>
                s.setMessage(
                  "현재 사이트·환경·페이지·선택 항목 링크를 복사했습니다.",
                ),
              )
              .catch(() => s.setMessage(`현재 작업 링크: ${navigation.link}`));
          }}
        >
          작업 위치 링크 복사
        </a>
      </div>
      <Suspense fallback={<p role="status">역할별 다음 업무를 확인하는 중…</p>}>
        <StudioTaskInbox
          studio={s}
          expansion={x}
          generation={g}
          variant={experiment.variant}
        />
      </Suspense>
      {experiment.error && (
        <p role="alert" className="bad">
          {experiment.error}
        </p>
      )}
      {s.message ? (
        <div className="notice" role="status">
          <span>{s.message}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="알림 닫기"
            onClick={() => s.setMessage("")}
          >
            ×
          </button>
        </div>
      ) : null}
      <div className="studio-body">
        <ToolPanel
          studio={s}
          generation={g}
          expansion={x}
          onTemplates={() => setWizard(true)}
        />
        <Workspace studio={s} onTemplates={() => setWizard(true)} />
        <aside
          id="studio-properties"
          className={`properties ${s.inspectorOpen ? "is-open" : ""}`}
        >
          <div className="properties-heading">
            <h2>{s.selectedBlock ? "선택 항목" : "사이트 설정"}</h2>
            <button
              type="button"
              className="icon-button"
              onClick={() => s.setSelected([])}
              aria-label="사이트 설정"
            >
              ⚙
            </button>
          </div>
          <fieldset className="inspector-permission" disabled={!s.editable}>
            <EnhancedInspector studio={s} />
          </fieldset>
          <Suspense fallback={<p role="status">연결·협업 도구 불러오는 중…</p>}>
            <CollaborationPanel studio={s} expansion={x} />
            {s.inspectorOpen && <DataBindingPanel studio={s} expansion={x} />}
          </Suspense>
        </aside>
      </div>
      {wizard ? (
        <ProjectWizard studio={s} onClose={() => setWizard(false)} />
      ) : null}
      {s.syncConflict?.local.id === s.project.id && (
        <Suspense fallback={<p role="status">서버 변경 비교를 불러오는 중…</p>}>
          <SyncReview
            key={`${s.syncConflict.local.id}:${s.syncConflict.local.revision}:${s.syncConflict.remote.revision}`}
            conflict={s.syncConflict}
            onClose={s.closeSyncReview}
            onApply={s.applySync}
          />
        </Suspense>
      )}
      {s.unsupportedImport && (
        <EditorDialog
          title="원본 호환성 검토 · 읽기 전용"
          onClose={s.closeUnsupportedImport}
        >
          <p>
            현재 편집기가 지원하지 않는 계약이 있습니다. 원본을 보존했으며 편집
            문서를 교체하지 않았습니다.
          </p>
          <ul>
            {s.unsupportedImport.issues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
          <details>
            <summary>가져온 원본 읽기</summary>
            <pre className="source-preview">{s.unsupportedImport.raw}</pre>
          </details>
          <button
            type="button"
            onClick={() =>
              downloadFile(s.unsupportedImport!.name, s.unsupportedImport!.raw)
            }
          >
            보존한 원본 다운로드
          </button>
        </EditorDialog>
      )}
      <Suspense fallback={null}>
        <StepUpDialog expansion={x} />
      </Suspense>
    </main>
  );
}
