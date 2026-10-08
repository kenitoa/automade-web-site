import type { ExpansionState } from "./useExpansion";
export default function ExpansionScopeBar({
  expansion: x,
}: {
  expansion: ExpansionState;
}) {
  return (
    <div className="expansion-scope-bar">
      <label>
        작업 공간
        <select
          aria-label="작업 공간"
          disabled={x.busy || !x.bootstrap}
          value={x.workspaceId}
          onChange={(e) => void x.selectWorkspace(e.target.value)}
        >
          <option value="">작업 공간 선택</option>
          {x.bootstrap?.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
              {w.archived ? " · 보관" : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        사이트
        <select
          aria-label="현재 사이트"
          disabled={x.busy || !x.bootstrap}
          value={x.scope?.siteId || ""}
          onChange={(e) => {
            const site = x.bootstrap?.sites.find(
              (s) => s.id === e.target.value,
            );
            if (site) void x.selectSite(site);
          }}
        >
          <option value="">사이트 선택</option>
          {x.bootstrap?.sites
            .filter(
              (site) => !x.workspaceId || site.workspaceId === x.workspaceId,
            )
            .map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        환경
        <select
          aria-label="현재 환경"
          disabled={x.busy || !x.scope?.siteId}
          value={x.environmentId}
          onChange={(e) => void x.selectEnvironment(e.target.value)}
        >
          <option value="">기본 환경</option>
          {x.bootstrap?.environments
            .filter((env) => env.siteId === x.scope?.siteId)
            .map((env) => (
              <option key={env.id} value={env.id}>
                {env.name} · {env.kind}
              </option>
            ))}
        </select>
      </label>
      <span>
        {x.session.localOwner ? "로컬 소유자" : x.session.account?.displayName}{" "}
        · {x.can("project.edit") ? "편집 가능" : "읽기 전용"}
      </span>
      {!x.session.localOwner && (
        <button type="button" onClick={() => void x.logout()}>
          제작자 로그아웃
        </button>
      )}
      {x.error && (
        <p role="alert" className="bad">
          {x.error}
          <button type="button" onClick={() => void x.refresh()}>
            작업 공간 재연결
          </button>
        </p>
      )}
    </div>
  );
}
