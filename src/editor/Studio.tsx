import { useEffect, useRef, useState, type ReactNode } from "react";
import { TEMPLATES, fromTemplate, type TemplateId } from "../domain/templates";
import { parseProject } from "../domain/validation";
import { persistProject } from "../infrastructure/library";
import { api } from "../infrastructure/api";
import { redo, undo } from "../domain/commands";
import Inspector from "./Inspector";
import Workspace from "./Workspace";
import ToolPanel from "./ToolPanel";
import { errorText, useStudio } from "./useStudio";
import { useGeneration } from "./useGeneration";
import "../runtime/site.css";
import "./studio.css";
export default function Studio() {
  const s = useStudio();
  const g = useGeneration(s);
  const [wizard, setWizard] = useState(false),
    [template, setTemplate] = useState<TemplateId>("company"),
    [name, setName] = useState("새 웹사이트"),
    [brief, setBrief] = useState(""),
    [creating, setCreating] = useState(false);
  const create = async () => {
    setCreating(true);
    try {
      const response = brief.trim()
        ? await api<{ project: unknown; source: string }>(
            "/api/generate",
            "POST",
            { name, prompt: brief },
          )
        : {
            project: fromTemplate(template, name, ""),
            source: "선택한 템플릿",
          };
      const p = parseProject(response.project);
      await persistProject(p);
      s.openProject(p);
      s.setLibrary((current) => [p, ...current]);
      s.setLoaded(true);
      setWizard(false);
      s.setMessage(
        `${response.source}으로 초안을 만들었습니다. 실제 내용을 확인해 주세요.`,
      );
    } catch (error) {
      s.setMessage(errorText(error));
    } finally {
      setCreating(false);
    }
  };
  return (
    <main className="studio">
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
        </div>
        <div className="top-actions">
          <button
            className="icon-button"
            type="button"
            disabled={!s.history.past.length}
            onClick={() => s.setHistory(undo)}
            title="실행 취소 (Ctrl+Z)"
            aria-label="실행 취소"
          >
            ↶
          </button>
          <button
            className="icon-button"
            type="button"
            disabled={!s.history.future.length}
            onClick={() => s.setHistory(redo)}
            title="다시 실행 (Ctrl+Y)"
            aria-label="다시 실행"
          >
            ↷
          </button>
          <button
            className="secondary"
            type="button"
            onClick={() => setWizard(true)}
          >
            새 프로젝트
          </button>
          <button
            className="primary create-button"
            type="button"
            disabled={g.busy || !s.loaded}
            onClick={() => {
              void g.oneClick();
            }}
          >
            {g.busy ? g.job?.stage || "처리 중…" : "사이트 만들고 열기 ↗"}
          </button>
        </div>
      </header>
      {s.message ? (
        <div className="notice" role="status">
          <span>{s.message}</span>
          <button
            className="icon-button"
            type="button"
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
          onTemplates={() => setWizard(true)}
        />
        <Workspace studio={s} onTemplates={() => setWizard(true)} />
        <aside className="properties">
          <div className="properties-heading">
            <h2>{s.selectedBlock ? "선택 항목" : "사이트 설정"}</h2>
            <button
              className="icon-button"
              type="button"
              onClick={() => s.setSelected([])}
              aria-label="사이트 설정"
            >
              ⚙
            </button>
          </div>
          <Inspector
            project={s.project}
            block={s.selectedBlock}
            selected={s.selected}
            update={s.apply}
          />
        </aside>
      </div>
      {wizard ? (
        <Wizard onClose={() => setWizard(false)}>
          <h2>새 웹사이트 만들기</h2>
          <p className="hint">
            목적에 맞는 구조로 시작하고 필요한 내용을 직접 편집하세요.
          </p>
          <label>
            사이트 이름
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
            />
          </label>
          <div className="template-grid">
            {TEMPLATES.map((t) => (
              <button
                className={template === t.id ? "template active" : "template"}
                type="button"
                key={t.id}
                onClick={() => setTemplate(t.id)}
              >
                <strong>{t.name}</strong>
                <small>{t.description}</small>
              </button>
            ))}
          </div>
          <label>
            자동 초안 요구 (선택)
            <textarea
              value={brief}
              maxLength={5000}
              rows={4}
              placeholder="어떤 사이트인지, 방문자에게 필요한 내용과 행동을 입력하세요."
              onChange={(e) => setBrief(e.target.value)}
            />
          </label>
          <p className="hint">
            요구를 입력하면 목적별 초안을 제안합니다. 외부 생성 API가 설정된
            경우 해당 서비스로 전송됩니다. 실제 실적·후기·연락처는 직접
            입력하세요.
          </p>
          <div className="dialog-actions">
            <button
              className="secondary"
              type="button"
              onClick={() => setWizard(false)}
            >
              취소
            </button>
            <button
              className="primary"
              type="button"
              disabled={creating || !name.trim()}
              onClick={() => {
                void create();
              }}
            >
              {creating ? "초안 만드는 중…" : "프로젝트 만들기"}
            </button>
          </div>
        </Wizard>
      ) : null}
    </main>
  );
}
function Wizard({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    node?.showModal();
    return () => {
      node?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog className="studio-dialog" ref={ref} onCancel={onClose}>
      {children}
    </dialog>
  );
}
