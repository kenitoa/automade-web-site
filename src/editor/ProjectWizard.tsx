import { useEffect, useState } from "react";
import { TEMPLATES, fromTemplate, type TemplateId } from "../domain/templates";
import { parseProject } from "../domain/validation";
import type { Project } from "../domain/types";
import { persistProject } from "../infrastructure/library";
import { api } from "../infrastructure/api";
import EditorDialog from "./EditorDialog";
import { trackStudioEvent } from "../infrastructure/telemetry";
import { errorText, type StudioState } from "./useStudio";
import {
  estimatedUsageText,
  parseGenerationSettings,
  type GenerationProviderSettings,
} from "../infrastructure/generationSettings";
export default function ProjectWizard({
  studio: s,
  onClose,
}: {
  studio: StudioState;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState<GenerationProviderSettings | null>(
      null,
    ),
    [allowExternal, setAllowExternal] = useState(false);
  useEffect(() => {
    let active = true;
    void api<unknown>("/api/generate/settings")
      .then((value) => {
        if (active) setProvider(parseGenerationSettings(value));
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, []);
  const [template, setTemplate] = useState<TemplateId>("company"),
    [name, setName] = useState("새 웹사이트"),
    [prompt, setPrompt] = useState(""),
    [mode, setMode] = useState<"template" | "recommend">("template"),
    [purpose, setPurpose] = useState<
      "business" | "portfolio" | "service" | "workspace"
    >("business"),
    [audience, setAudience] = useState(""),
    [goal, setGoal] = useState(""),
    [tone, setTone] = useState("차분하고 명확하게"),
    [materials, setMaterials] = useState(""),
    [busy, setBusy] = useState(false),
    [draft, setDraft] = useState<Project | null>(null),
    [source, setSource] = useState(""),
    [error, setError] = useState("");
  async function prepare() {
    setBusy(true);
    setError("");
    try {
      const facts = materials
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
      const response =
        prompt.trim() || mode === "recommend"
          ? await api<{ project: unknown; source: string }>(
              "/api/generate",
              "POST",
              {
                name,
                prompt: prompt || `${purpose}: ${audience}, ${goal}`,
                template,
                mode,
                purpose,
                audience,
                primaryGoal: goal,
                tone,
                materials: facts,
              },
            )
          : {
              project: fromTemplate(template, name, ""),
              source: "선택한 템플릿",
            };
      const next = parseProject(response.project);
      next.settings.brief = {
        purpose,
        audience,
        primaryGoal: goal,
        tone,
        materials: facts,
      };
      setDraft(next);
      setSource(response.source);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function accept() {
    if (!draft) return;
    setBusy(true);
    try {
      await persistProject(draft);
      s.openProject(draft);
      s.setLibrary((current) => [draft, ...current]);
      s.setLoaded(true);
      void trackStudioEvent(draft.id, "project.start");
      s.setMessage(
        `${source} 초안을 적용했습니다. 연락처·가격·실적은 실제 자료를 확인하세요.`,
      );
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <EditorDialog title="새 웹사이트 만들기" onClose={onClose}>
      {draft ? (
        <>
          <p className="hint">
            {source} · 적용 전 구조와 사실을 확인하세요. 현재 프로젝트는
            보존됩니다.
          </p>
          <h3>{draft.name}</h3>
          <div className="preview-outline">
            {draft.pages.map((page) => (
              <article key={page.id}>
                <strong>
                  {page.title} · {page.path}
                </strong>
                <p>
                  {draft.blocks
                    .filter((b) => b.pageId === page.id || b.pageId === "*")
                    .map((b) => b.props.title || b.name)
                    .join(" → ")}
                </p>
              </article>
            ))}
          </div>
          <p>
            {draft.pages.length}페이지 · {draft.blocks.length}블록 ·{" "}
            {draft.assets.length}이미지
          </p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setDraft(null)}>
              요구 수정
            </button>
            <button
              className="primary"
              type="button"
              disabled={busy}
              onClick={() => void accept()}
            >
              검토한 초안 적용
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="hint">
            목적과 실제 자료를 먼저 정하면 필요한 구조와 행동을 명확히 만들 수
            있습니다.
          </p>
          <label>
            사이트 이름
            <input
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="number-grid">
            <label>
              사이트 목적
              <select
                value={purpose}
                onChange={(e) => setPurpose(e.target.value as typeof purpose)}
              >
                <option value="business">업체 소개·문의</option>
                <option value="portfolio">포트폴리오·연락</option>
                <option value="service">서비스·전환</option>
                <option value="workspace">내부 업무·데이터</option>
              </select>
            </label>
            <label>
              주요 방문자
              <input
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                placeholder="예: 첫 상담을 고민하는 고객"
                maxLength={500}
              />
            </label>
          </div>
          <label>
            방문자가 하길 원하는 행동
            <input
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="예: 상담 문의를 제출하기"
              maxLength={500}
            />
          </label>
          <div className="template-grid">
            {TEMPLATES.map((t) => (
              <button
                type="button"
                className={`template ${template === t.id ? "active" : ""}`}
                key={t.id}
                onClick={() => setTemplate(t.id)}
              >
                <span
                  className={`template-thumb thumb-${t.id}`}
                  aria-hidden="true"
                >
                  ▰ ▱ ▱
                </span>
                <strong>{t.name}</strong>
                <small>{t.description}</small>
              </button>
            ))}
          </div>
          <label>
            구조 선택 방식
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
            >
              <option value="template">선택한 템플릿 구조 유지</option>
              <option value="recommend">요구에 맞는 구조 추천</option>
            </select>
          </label>
          <label>
            문구 분위기
            <input
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              maxLength={200}
            />
          </label>
          <label>
            확인된 실제 자료 (한 줄에 하나)
            <textarea
              value={materials}
              onChange={(e) => setMaterials(e.target.value)}
              rows={3}
              maxLength={5000}
              placeholder="실제 연락처, 제공 서비스, 확인된 가격·실적"
            />
          </label>
          <label>
            추가 요구
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              maxLength={5000}
            />
          </label>
          <p className="hint">
            외부 생성 공급자를 연결한 경우 입력한 요구와 자료가 해당 공급자로
            전송됩니다. 비밀번호·비밀키·불필요한 개인정보를 입력하지 마세요.
            연결하지 않으면 로컬 템플릿으로 구성합니다.
          </p>
          {provider ? (
            <p className="hint">
              {provider.configured
                ? `생성 공급자 ${provider.host} · 사용 ${provider.usage.used}/${provider.usage.budget}회 · ${estimatedUsageText(provider.usage)}`
                : "외부 공급자 미연결 · 로컬 템플릿 구성"}
            </p>
          ) : null}
          {provider?.configured && (prompt.trim() || mode === "recommend") ? (
            <label className="check">
              <input
                type="checkbox"
                checked={allowExternal}
                onChange={(e) => setAllowExternal(e.target.checked)}
              />
              입력한 요구·자료의 외부 전송 확인
            </label>
          ) : null}
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              취소
            </button>
            <button
              type="button"
              className="primary"
              disabled={
                busy ||
                !name.trim() ||
                Boolean(
                  provider?.configured &&
                  (prompt.trim() || mode === "recommend") &&
                  !allowExternal,
                )
              }
              onClick={() => void prepare()}
            >
              {busy ? "초안 만드는 중…" : "구조 미리보기"}
            </button>
          </div>
        </>
      )}
      {error ? (
        <p role="alert" className="bad">
          {error}
        </p>
      ) : null}
    </EditorDialog>
  );
}
