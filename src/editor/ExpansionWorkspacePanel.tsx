import { useState, type FormEvent } from "react";
import { createProject, uid } from "../domain/catalog";
import { parseProject } from "../domain/validation";
import type { Project } from "../domain/types";
import { api } from "../infrastructure/api";
import type { StudioState } from "./useStudio";
import { materializeProjectAssets } from "../infrastructure/blobAssets";
import type { ExpansionState } from "./useExpansion";
import EditorDialog from "./EditorDialog";
import ExpansionTeamPanel from "./ExpansionTeamPanel";
export default function ExpansionWorkspacePanel({
  studio: s,
  expansion: x,
}: {
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [organization, setOrganization] = useState(""),
    [workspace, setWorkspace] = useState(""),
    [prepared, setPrepared] = useState<Project | null>(null),
    [query, setQuery] = useState("");
  const organizationId =
      organization ||
      x.scope?.organizationId ||
      x.bootstrap?.organizations[0]?.id ||
      "",
    workspaceId =
      workspace ||
      x.scope?.workspaceId ||
      x.bootstrap?.workspaces.find((w) => w.organizationId === organizationId)
        ?.id ||
      "";
  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError("");
    try {
      await action();
      await x.refresh();
      s.setMessage(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "작업 공간 요청을 확인하세요.");
    } finally {
      setBusy(false);
    }
  }
  function values(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    return Object.fromEntries(new FormData(event.currentTarget));
  }
  function prepareSite(event: FormEvent<HTMLFormElement>) {
    const fields = values(event),
      project =
        fields.mode === "copy"
          ? structuredClone(s.project)
          : createProject(String(fields.name));
    project.id = uid();
    project.name = String(fields.name);
    project.revision = 0;
    project.updatedAt = new Date().toISOString();
    project.settings.siteUrl = "";
    project.extensions = { ...project.extensions, archived: false };
    for (const block of project.blocks) delete block.props.dataBinding;
    setPrepared(parseProject(project));
  }
  async function createSite() {
    if (!prepared) return;
    await run(async () => {
      const materialized = await materializeProjectAssets(prepared);
      const result = await api<{ project?: unknown }>(
        `/api/projects?workspaceId=${encodeURIComponent(workspaceId)}`,
        "PUT",
        { project: materialized, baseRevision: -1 },
      );
      await s.openServerProject(
        result.project ? parseProject(result.project) : materialized,
      );
      setPrepared(null);
    }, "검토한 새 사이트를 만들었습니다. 운영 데이터와 연결 비밀은 복사하지 않습니다.");
  }
  return (
    <details className="expansion-panel" open>
      <summary>작업 공간·사이트 관리</summary>
      <p className="hint">
        조직은 소유 범위, 작업 공간은 팀 작업 분류, 사이트는 운영 단위, 환경은
        검수·운영 데이터 범위입니다.
      </p>
      <label>
        관리 조직
        <select
          value={organizationId}
          onChange={(e) => {
            setOrganization(e.target.value);
            setWorkspace("");
          }}
        >
          {x.bootstrap?.organizations.map((org) => (
            <option key={org.id} value={org.id}>
              {org.name} · {org.role || "접근"}
            </option>
          ))}
        </select>
      </label>
      <form
        onSubmit={(e) => {
          const body = values(e);
          void run(
            () => x.request("organizations", "POST", body),
            "조직을 만들었습니다.",
          );
        }}
      >
        <label>
          새 조직 이름
          <input name="name" required maxLength={100} />
        </label>
        <button disabled={busy}>조직 생성</button>
      </form>
      <form
        onSubmit={(e) => {
          const body = values(e);
          void run(
            () => x.request("workspaces", "POST", { ...body, organizationId }),
            "작업 공간을 만들었습니다.",
          );
        }}
      >
        <label>
          새 작업 공간 이름
          <input name="name" required maxLength={100} />
        </label>
        <button disabled={busy || !organizationId}>작업 공간 생성</button>
      </form>
      <label>
        대상 작업 공간
        <select
          value={workspaceId}
          onChange={(e) => setWorkspace(e.target.value)}
        >
          {x.bootstrap?.workspaces
            .filter((w) => w.organizationId === organizationId)
            .map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.archived ? " · 보관" : ""}
              </option>
            ))}
        </select>
      </label>
      {x.bootstrap?.workspaces
        .filter((w) => w.organizationId === organizationId)
        .map((w) => (
          <article className="page-card" key={w.id}>
            <strong>{w.name}</strong>
            <form
              onSubmit={(e) => {
                const body = values(e);
                void run(
                  () =>
                    x.request(`workspaces/${w.id}`, "PUT", {
                      ...body,
                      archived: w.archived,
                      config: w.config,
                    }),
                  "작업 공간 이름을 저장했습니다.",
                );
              }}
            >
              <label>
                작업 공간 표시 이름
                <input
                  name="name"
                  defaultValue={w.name}
                  required
                  maxLength={100}
                />
              </label>
              <button disabled={busy || !x.can("workspace.manage")}>
                작업 공간 이름 저장
              </button>
            </form>
            <div className="button-row">
              <button
                type="button"
                onClick={() => void x.selectWorkspace(w.id)}
              >
                작업 공간 열기
              </button>
              <button
                type="button"
                disabled={busy || !x.can("workspace.manage")}
                onClick={() =>
                  void run(
                    () =>
                      x.request(`workspaces/${w.id}`, "PUT", {
                        name: w.name,
                        archived: !w.archived,
                        config: w.config,
                      }),
                    w.archived
                      ? "보관을 해제했습니다."
                      : "작업 공간을 보관했습니다.",
                  )
                }
              >
                {w.archived ? "보관 해제" : "보관"}
              </button>
            </div>
          </article>
        ))}
      <form onSubmit={prepareSite}>
        <label>
          새 사이트 이름
          <input name="name" required maxLength={100} />
        </label>
        <label>
          제작 원본
          <select name="mode">
            <option value="blank">빈 사이트</option>
            <option value="copy">현재 디자인·콘텐츠 복사</option>
          </select>
        </label>
        <button disabled={busy || !workspaceId || !x.can("project.create")}>
          새 사이트 범위 검토
        </button>
      </form>
      <label>
        사이트 검색
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {x.bootstrap?.sites
        .filter(
          (site) =>
            site.workspaceId === workspaceId &&
            site.name.toLowerCase().includes(query.toLowerCase()),
        )
        .map((site) => (
          <article className="page-card" key={site.id}>
            <strong>{site.name}</strong>
            <form
              onSubmit={(e) => {
                const body = values(e);
                void run(
                  () =>
                    x.request(`sites/${site.id}`, "PUT", {
                      name: body.name,
                      archived: site.archived,
                      config: {
                        ...site.config,
                        assignee: body.assignee,
                        brand: body.brand,
                      },
                    }),
                  "사이트 담당·브랜드 정보를 저장했습니다.",
                );
              }}
            >
              <label>
                사이트 표시 이름
                <input
                  name="name"
                  defaultValue={site.name}
                  required
                  maxLength={100}
                />
              </label>
              <label>
                사이트 담당
                <input
                  name="assignee"
                  defaultValue={
                    typeof site.config.assignee === "string"
                      ? site.config.assignee
                      : ""
                  }
                  maxLength={100}
                />
              </label>
              <label>
                사이트 브랜드 분류
                <input
                  name="brand"
                  defaultValue={
                    typeof site.config.brand === "string"
                      ? site.config.brand
                      : ""
                  }
                  maxLength={100}
                />
              </label>
              <button disabled={busy || !x.can("workspace.manage")}>
                사이트 관리 정보 저장
              </button>
            </form>
            <small>
              {site.mode} · {site.archived ? "보관" : "활성"}
            </small>
            <div className="button-row">
              <button type="button" onClick={() => void x.selectSite(site)}>
                사이트 편집 열기
              </button>
              <button
                type="button"
                disabled={busy || !x.can("workspace.manage")}
                onClick={() =>
                  void run(
                    () =>
                      x.request(`sites/${site.id}`, "PUT", {
                        name: site.name,
                        archived: !site.archived,
                        config: site.config,
                      }),
                    "사이트 보관 상태를 저장했습니다.",
                  )
                }
              >
                {site.archived ? "보관 해제" : "보관"}
              </button>
            </div>
          </article>
        ))}
      <form
        onSubmit={(e) => {
          const body = values(e);
          void run(
            () =>
              x.request("environments", "POST", {
                ...body,
                siteId: x.scope?.siteId,
              }),
            "환경을 만들었습니다. 데이터와 연결 설정은 환경별로 관리합니다.",
          );
        }}
      >
        <label>
          새 환경 이름
          <input name="name" required maxLength={100} />
        </label>
        <label>
          환경 용도
          <select name="kind">
            <option value="staging">검수</option>
            <option value="development">개발</option>
            <option value="production">운영</option>
          </select>
        </label>
        <button
          disabled={busy || !x.scope?.siteId || !x.can("workspace.manage")}
        >
          환경 생성
        </button>
      </form>
      <ExpansionTeamPanel expansion={x} organizationId={organizationId} />
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      {prepared && (
        <EditorDialog
          title="새 사이트 제작 범위 검토"
          onClose={() => setPrepared(null)}
        >
          <p>
            {prepared.name}: 페이지 {prepared.pages.length}개 · 블록{" "}
            {prepared.blocks.length}개 · 콘텐츠{" "}
            {prepared.collections?.reduce(
              (count, c) => count + c.records.length,
              0,
            ) || 0}
            개
          </p>
          <p>
            선택 작업 공간{" "}
            {x.bootstrap?.workspaces.find((w) => w.id === workspaceId)?.name}에
            제작 원본을 저장합니다. 방문자·주문·문의·예약·결제·외부 연결 비밀은
            복사하지 않습니다. 기존 사이트는 보존합니다.
          </p>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void createSite()}
          >
            {busy ? "사이트 저장 중…" : "검토한 사이트 생성"}
          </button>
        </EditorDialog>
      )}
    </details>
  );
}
