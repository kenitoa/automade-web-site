import { useEffect, useState } from "react";
import { api } from "../infrastructure/api";
import { parseProject } from "../domain/validation";
import { historyChange } from "../domain/commands";
import type { Project } from "../domain/types";
import { errorText, type StudioState } from "./useStudio";
import EditorDialog from "./EditorDialog";
import ChangeReview from "./ChangeReview";
import {
  validateProposalScope,
  type ProposalScope,
} from "../domain/scopedProposals";
import {
  estimatedUsageText,
  parseGenerationSettings,
  type GenerationProviderSettings,
} from "../infrastructure/generationSettings";
export default function AIAssistant({ studio: s }: { studio: StudioState }) {
  const [settings, setSettings] = useState<GenerationProviderSettings | null>(
    null,
  );
  useEffect(() => {
    let active = true;
    void api<unknown>("/api/generate/settings")
      .then((value) => {
        if (active) setSettings(parseGenerationSettings(value));
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, []);
  const [instruction, setInstruction] = useState(""),
    [operation, setOperation] = useState("copy"),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [proposal, setProposal] = useState<Project | null>(null),
    [source, setSource] = useState(""),
    [revision, setRevision] = useState(0),
    [error, setError] = useState("");
  const [scopeKind, setScopeKind] = useState<ProposalScope["kind"]>(
      s.selectedBlock ? "block" : "page",
    ),
    [cmsId, setCmsId] = useState(""),
    [fields, setFields] = useState<("title" | "body")[]>(["title", "body"]);
  const scope: ProposalScope = {
    kind: scopeKind,
    ...(scopeKind === "block"
      ? { targetId: s.selectedBlock?.id }
      : scopeKind === "page"
        ? { targetId: s.pageId }
        : scopeKind === "cms"
          ? { targetId: cmsId }
          : {}),
    ...(scopeKind === "cms" ? { allowedFieldIds: fields } : {}),
  };
  async function request() {
    setBusy(true);
    setError("");
    try {
      validateProposalScope(s.project, scope);
      const result = await api<{
        project: unknown;
        source: string;
        external: boolean;
      }>("/api/generate/proposal", "POST", {
        project: s.project,
        instruction,
        operation,
        blockId: scopeKind === "block" ? s.selectedBlock?.id : undefined,
        scope,
      });
      setProposal(parseProject(result.project));
      setRevision(s.project.revision);
      setSource(result.source);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="ai-assistant">
      <summary>AI 수정 제안</summary>
      {settings ? (
        <p className="hint">
          {settings.configured ? `연결: ${settings.host}` : "AI 공급자 미연결"}{" "}
          · 이번 기간 {settings.usage.used}/{settings.usage.budget}회
          {` · ${estimatedUsageText(settings.usage)}`}
        </p>
      ) : null}
      <p className="hint">
        {s.selectedBlock ? `선택 블록: ${s.selectedBlock.name}` : "사이트 전체"}{" "}
        · 외부 공급자 연결이 필요합니다. 연결되지 않으면 실제 AI 결과를 제공하지
        않습니다.
      </p>
      <label>
        AI 수정 범위
        <select
          value={scopeKind}
          onChange={(e) => {
            setScopeKind(e.target.value as ProposalScope["kind"]);
            setConsent(false);
          }}
        >
          <option value="block" disabled={!s.selectedBlock}>
            선택한 공개·잠금 해제 블록
          </option>
          <option value="page">현재 공개 페이지</option>
          <option value="site">공개 사이트 문구·구조</option>
          <option value="cms">선택 CMS 제목·본문</option>
        </select>
      </label>
      {scopeKind === "cms" && (
        <>
          <label>
            수정할 공개 CMS 자료
            <select
              value={cmsId}
              onChange={(e) => {
                setCmsId(e.target.value);
                setConsent(false);
              }}
            >
              <option value="">자료 선택</option>
              {s.project.collections
                ?.filter((c) => c.access !== "members")
                .flatMap((c) =>
                  c.records.map((r) => (
                    <option key={r.id} value={r.id}>
                      {c.name} · {r.title}
                    </option>
                  )),
                )}
            </select>
          </label>
          {(["title", "body"] as const).map((field) => (
            <label className="check" key={field}>
              <input
                type="checkbox"
                checked={fields.includes(field)}
                onChange={(e) => {
                  setFields((list) =>
                    e.target.checked
                      ? [...list, field]
                      : list.filter((v) => v !== field),
                  );
                  setConsent(false);
                }}
              />
              {field === "title" ? "제목 변경 허용" : "본문 변경 허용"}
            </label>
          ))}
        </>
      )}
      <label>
        수정 종류
        <select
          value={operation}
          onChange={(e) => setOperation(e.target.value)}
        >
          {[
            ["copy", "문구 수정"],
            ["tone", "분위기 조정"],
            ["translate", "번역"],
            ["layout", "배치 개선"],
            ["mobile", "모바일 개선"],
          ].map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        수정 요구
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          maxLength={3000}
          rows={3}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        전송할 자료를 확인했습니다
      </label>
      <p className="hint">
        선택 범위의 공개 문구와 빈 식별 구조가 연결한 생성 공급자에게
        전송됩니다. CMS 범위에서는 선택 자료의 허용한 제목·본문만 보내며 내부
        자료 필드는 제외합니다. 이미지 파일·기획 자료·비밀 설정·회원
        전용·숨김·잠금 콘텐츠는 제외됩니다. 개인정보·비밀값을 제거한 뒤
        요청하세요. 결과는 검토 후 적용합니다.
      </p>
      <button
        type="button"
        disabled={
          !consent ||
          !instruction.trim() ||
          busy ||
          (scopeKind === "cms" && (!cmsId || !fields.length))
        }
        onClick={() => void request()}
      >
        {busy ? "제안 준비 중…" : "외부 공급자에 수정 제안 요청"}
      </button>
      {error ? (
        <p className="bad" role="alert">
          {error}
        </p>
      ) : null}
      {proposal ? (
        <EditorDialog
          title="AI 제안 비교·적용"
          onClose={() => setProposal(null)}
        >
          <p>
            {source} · 요청 당시 편집본 v{revision}
          </p>
          {s.project.revision !== revision ? (
            <p className="bad">
              요청 이후 편집본이 변경되었습니다. 새 제안을 요청하세요.
            </p>
          ) : null}
          {proposal.blocks
            .filter(
              (next) =>
                JSON.stringify(next) !==
                JSON.stringify(s.project.blocks.find((b) => b.id === next.id)),
            )
            .map((next) => {
              const before = s.project.blocks.find((b) => b.id === next.id);
              return (
                <article key={next.id} className="page-card">
                  <h3>{next.name}</h3>
                  <strong>현재 문구</strong>
                  <p>{before?.props.title}</p>
                  <p>{before?.props.body}</p>
                  <strong>제안 문구</strong>
                  <p>{next.props.title}</p>
                  <p>{next.props.body}</p>
                  <p>
                    배치: {before?.layout.mode} → {next.layout.mode}, 간격{" "}
                    {before?.layout.gap} → {next.layout.gap}
                  </p>
                  <details>
                    <summary>전체 변경 항목 확인</summary>
                    <ChangeReview before={before} after={next} />
                  </details>
                </article>
              );
            })}
          <details>
            <summary>콘텐츠 컬렉션 변경 확인</summary>
            <ChangeReview
              before={s.project.collections}
              after={proposal.collections}
            />
          </details>
          <details>
            <summary>사이트·페이지 설정 변경 확인</summary>
            <ChangeReview
              before={{
                settings: s.project.settings,
                theme: s.project.theme,
                pages: s.project.pages,
              }}
              after={{
                settings: proposal.settings,
                theme: proposal.theme,
                pages: proposal.pages,
              }}
            />
          </details>
          <button
            type="button"
            className="primary"
            disabled={s.project.revision !== revision}
            onClick={() => {
              s.setHistory((current) =>
                historyChange(current, {
                  ...proposal,
                  revision: current.present.revision + 1,
                  updatedAt: new Date().toISOString(),
                }),
              );
              setProposal(null);
              s.setMessage(
                "검토한 AI 제안을 적용했습니다. 실행 취소로 복구할 수 있습니다.",
              );
            }}
          >
            검토한 변경 적용
          </button>
        </EditorDialog>
      ) : null}
    </details>
  );
}
