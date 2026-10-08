import { useEffect, useState, type FormEvent } from "react";
import {
  EXPANSION_CAPABILITIES,
  type ExpansionMember,
  type ExpansionCapability,
  type OrganizationRole,
} from "../domain/expansion";
import type { ExpansionState } from "./useExpansion";
export default function ExpansionTeamPanel({
  expansion: x,
  organizationId,
}: {
  expansion: ExpansionState;
  organizationId: string;
}) {
  const [members, setMembers] = useState<ExpansionMember[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [invite, setInvite] = useState("");
  async function refresh() {
    if (!organizationId) return;
    try {
      setMembers(
        await x.request<ExpansionMember[]>(
          `members?organizationId=${encodeURIComponent(organizationId)}`,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "팀을 확인하세요.");
    }
  }
  useEffect(() => {
    void refresh();
  }, [organizationId]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "권한 변경을 확인하세요.");
    } finally {
      setBusy(false);
    }
  }
  function inviteMember(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void run(async () => {
      const result = await x.request<{ token?: string; id?: string }>(
        "invites",
        "POST",
        {
          organizationId,
          email: form.get("email"),
          role: form.get("role"),
          workspaceId: form.get("workspaceId") || undefined,
          capabilities: form.getAll("capability"),
        },
      );
      setInvite(
        result.token || "초대를 저장했습니다. 설정된 전달 수단을 확인하세요.",
      );
    });
  }
  return (
    <details>
      <summary>제작 팀·세부 권한</summary>
      <p className="hint">
        사이트 방문자 역할과 분리된 제작자 권한입니다. 서버가 작업 공간과
        프로젝트별 권한을 재확인합니다.
      </p>
      {members.map((member) => (
        <MemberEditor
          key={member.account.id}
          member={member}
          expansion={x}
          organizationId={organizationId}
          disabled={busy || !x.can("team.manage")}
          run={run}
        />
      ))}
      <form onSubmit={inviteMember}>
        <label>
          초대할 제작자 이메일
          <input name="email" type="email" required maxLength={254} />
        </label>
        <label>
          조직 역할
          <select name="role">
            <option value="member">멤버</option>
            <option value="admin">관리자</option>
            <option value="billing">청구 담당</option>
          </select>
        </label>
        <label>
          초대 작업 공간
          <select name="workspaceId">
            <option value="">조직 범위</option>
            {x.bootstrap?.workspaces
              .filter((w) => w.organizationId === organizationId)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
          </select>
        </label>
        <fieldset>
          <legend>작업 허용 범위</legend>
          {EXPANSION_CAPABILITIES.map((cap) => (
            <label className="check" key={cap}>
              <input
                type="checkbox"
                name="capability"
                value={cap}
                defaultChecked={cap === "project.read"}
              />
              {cap}
            </label>
          ))}
        </fieldset>
        <button disabled={busy || !x.can("team.manage")}>
          초대 권한 검토·저장
        </button>
      </form>
      {invite && (
        <label>
          초대 결과
          <textarea readOnly value={invite} />
        </label>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const token = new FormData(e.currentTarget).get("token");
          void run(() => x.request("invites/accept", "POST", { token }));
        }}
      >
        <label>
          받은 초대 토큰
          <input name="token" required autoComplete="off" />
        </label>
        <button disabled={busy}>초대 수락</button>
      </form>
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
    </details>
  );
}
function MemberEditor({
  member,
  expansion: x,
  organizationId,
  disabled,
  run,
}: {
  member: ExpansionMember;
  expansion: ExpansionState;
  organizationId: string;
  disabled: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [role, setRole] = useState<OrganizationRole>(member.role),
    [workspaceId, setWorkspaceId] = useState(
      member.workspaceGrants[0]?.workspaceId || "",
    ),
    [capabilities, setCapabilities] = useState<ExpansionCapability[]>(
      member.workspaceGrants[0]?.capabilities || [],
    ),
    [projectId, setProjectId] = useState(
      member.projectGrants[0]?.projectId || "",
    ),
    [projectCapabilities, setProjectCapabilities] = useState<
      ExpansionCapability[]
    >(member.projectGrants[0]?.capabilities || []);
  useEffect(() => {
    setRole(member.role);
    setCapabilities(
      member.workspaceGrants.find((g) => g.workspaceId === workspaceId)
        ?.capabilities || [],
    );
    setProjectCapabilities(
      member.projectGrants.find((g) => g.projectId === projectId)
        ?.capabilities || [],
    );
  }, [member]);
  return (
    <article className="page-card">
      <strong>
        {member.account.displayName} · {member.account.email}
      </strong>
      <label>
        조직 역할
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as OrganizationRole)}
        >
          <option value="owner">소유자</option>
          <option value="admin">관리자</option>
          <option value="member">멤버</option>
          <option value="billing">청구 담당</option>
        </select>
      </label>
      <label>
        변경할 작업 공간
        <select
          value={workspaceId}
          onChange={(e) => {
            setWorkspaceId(e.target.value);
            setCapabilities(
              member.workspaceGrants.find(
                (grant) => grant.workspaceId === e.target.value,
              )?.capabilities || [],
            );
          }}
        >
          <option value="">작업 공간 선택</option>
          {x.bootstrap?.workspaces
            .filter((w) => w.organizationId === organizationId)
            .map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
        </select>
      </label>
      <fieldset>
        <legend>세부 작업 권한</legend>
        {EXPANSION_CAPABILITIES.map((cap) => (
          <label className="check" key={cap}>
            <input
              type="checkbox"
              checked={capabilities.includes(cap)}
              onChange={(e) =>
                setCapabilities(
                  e.target.checked
                    ? [...capabilities, cap]
                    : capabilities.filter((item) => item !== cap),
                )
              }
            />
            {cap}
          </label>
        ))}
      </fieldset>
      <label>
        변경할 사이트 권한
        <select
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setProjectCapabilities(
              member.projectGrants.find((g) => g.projectId === e.target.value)
                ?.capabilities || [],
            );
          }}
        >
          <option value="">사이트 선택</option>
          {x.bootstrap?.sites
            .filter((site) =>
              x.bootstrap?.workspaces.some(
                (w) =>
                  w.id === site.workspaceId &&
                  w.organizationId === organizationId,
              ),
            )
            .map((site) => (
              <option key={site.id} value={site.projectId}>
                {site.name}
              </option>
            ))}
        </select>
      </label>
      <fieldset disabled={!projectId}>
        <legend>선택 사이트 세부 권한</legend>
        {EXPANSION_CAPABILITIES.map((cap) => (
          <label className="check" key={cap}>
            <input
              type="checkbox"
              checked={projectCapabilities.includes(cap)}
              onChange={(e) =>
                setProjectCapabilities(
                  e.target.checked
                    ? [...projectCapabilities, cap]
                    : projectCapabilities.filter((item) => item !== cap),
                )
              }
            />
            {cap}
          </label>
        ))}
      </fieldset>
      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          void run(() =>
            x.request(`members/${member.account.id}`, "PUT", {
              organizationId,
              role,
              workspaceGrants: [
                ...member.workspaceGrants.filter(
                  (g) => g.workspaceId !== workspaceId,
                ),
                ...(workspaceId ? [{ workspaceId, capabilities }] : []),
              ],
              projectGrants: [
                ...member.projectGrants.filter(
                  (g) => g.projectId !== projectId,
                ),
                ...(projectId
                  ? [{ projectId, capabilities: projectCapabilities }]
                  : []),
              ],
            }),
          )
        }
      >
        검토한 권한 저장
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (
            window.confirm(
              `${member.account.displayName}의 조직 접근과 세션을 회수합니다. 운영 거래 자료는 보존됩니다.`,
            )
          )
            void run(() =>
              x.request(
                `members/${member.account.id}?organizationId=${encodeURIComponent(organizationId)}`,
                "DELETE",
              ),
            );
        }}
      >
        접근 회수
      </button>
      <button
        type="button"
        disabled={disabled || role !== "owner"}
        onClick={() => {
          if (
            window.confirm(
              `이 조직의 소유권을 ${member.account.displayName}에게 인계합니다. 서버가 마지막 소유자와 권한을 확인합니다.`,
            )
          )
            void run(() =>
              x.request(`organizations/${organizationId}/transfer`, "POST", {
                accountId: member.account.id,
              }),
            );
        }}
      >
        이 소유자에게 조직 인계
      </button>
    </article>
  );
}
