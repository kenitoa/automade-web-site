import { useEffect, useState, type FormEvent } from "react";
import type { DeclarativeBlockPackage, Project } from "../domain/types";
import type {
  ExpansionLibraryItem,
  PackInstallation,
} from "../domain/expansion";
import {
  packageIntegrity,
  parseDeclarativePackage,
  verifyPackageIntegrity,
} from "../domain/packages";
import { parseProject } from "../domain/validation";
import type { ExpansionState } from "./useExpansion";
import type { StudioState } from "./useStudio";
import EditorDialog from "./EditorDialog";
import ChangeReview from "./ChangeReview";
interface PackPreview {
  project: Project;
  changes: unknown[];
  baseRevision: number;
  approvalFingerprint: string;
}
export default function PackPanel({
  studio: s,
  expansion: x,
}: {
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const [catalog, setCatalog] = useState<ExpansionLibraryItem[]>([]),
    [installed, setInstalled] = useState<PackInstallation[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<{
      response: PackPreview;
      request: Record<string, unknown>;
      before: Project;
    } | null>(null);
  async function refresh() {
    try {
      const [catalog, installed] = await Promise.all([
        x.request<ExpansionLibraryItem[]>("library"),
        x.request<PackInstallation[]>("packs"),
      ]);
      setCatalog(catalog.filter((item) => item.kind === "pack"));
      setInstalled(installed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "팩 목록을 확인하세요.");
    }
  }
  useEffect(() => {
    void refresh();
  }, [x.scope?.projectId, x.scope?.organizationId]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "팩 계약을 확인하세요.");
    } finally {
      setBusy(false);
    }
  }
  async function prepare(manifest: DeclarativeBlockPackage, mode: string) {
    await run(async () => {
      await verifyPackageIntegrity(manifest);
      if (!(await s.syncProject(s.project)))
        throw new Error("원본 동기화 검토를 먼저 완료하세요.");
      const request = {
        projectId: s.project.id,
        manifest,
        mode,
        baseRevision: s.project.revision,
        pageId: s.pageId,
        definitionIds: manifest.definitions.map((d) => d.id),
      };
      const response = await x.request<PackPreview>(
        "packs/preview",
        "POST",
        request,
      );
      setPreview({
        response: { ...response, project: parseProject(response.project) },
        request,
        before: structuredClone(s.project),
      });
    });
  }
  async function register(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fields = Object.fromEntries(new FormData(e.currentTarget));
    await run(async () => {
      const raw = {
        id: fields.id,
        name: fields.name,
        version: fields.version,
        protocol: 1,
        integrity: "sha256-" + "0".repeat(64),
        definitions: [
          {
            id: "section",
            name: fields.name,
            description: fields.description,
            template: fields.template,
            defaults: { title: fields.title, body: fields.body },
          },
        ],
      };
      raw.integrity = await packageIntegrity(raw);
      const manifest = parseDeclarativePackage(raw);
      await verifyPackageIntegrity(manifest);
      await x.request("library", "POST", {
        organizationId: x.scope?.organizationId,
        kind: "pack",
        name: manifest.name,
        body: manifest,
      });
      await refresh();
      s.setMessage(
        "선언형 업종팩을 조직 라이브러리에 등록했습니다. 설치는 변경 검토 후 진행합니다.",
      );
    });
  }
  return (
    <details className="expansion-panel">
      <summary>버전 업종팩·블록 모듈</summary>
      <p className="hint">
        검증된 표시 계약과 고정 무결성을 사용합니다. 설치·업데이트·중지·제거
        전에 원본 변경과 사용 블록을 검토합니다.
      </p>
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        팩 목록 새로고침
      </button>
      {catalog.map((item) => {
        let manifest: DeclarativeBlockPackage;
        try {
          manifest = parseDeclarativePackage(item.body);
        } catch {
          return (
            <p className="bad" key={item.id}>
              {item.name}: 지원 계약 확인 필요
            </p>
          );
        }
        const pack = manifest;
        return (
          <article className="page-card" key={item.id}>
            <strong>
              {pack.name} · {pack.version}
            </strong>
            <p>
              {pack.definitions.length}개 정의 ·{" "}
              {installed.some(
                (entry) => entry.packageId === pack.id && !entry.removed,
              )
                ? "설치 기록 있음"
                : "미설치"}
            </p>
            <div className="button-row">
              {[
                ["install", "설치 검토"],
                ["upgrade", "업데이트 검토"],
                ["pause", "중지 영향 검토"],
                ["remove", "제거 영향 검토"],
              ].map(([mode, label]) => (
                <button
                  type="button"
                  key={mode}
                  disabled={busy || !x.can("project.edit")}
                  onClick={() => void prepare(pack, mode!)}
                >
                  {label}
                </button>
              ))}
            </div>
          </article>
        );
      })}
      {installed.map((entry) => (
        <article className="page-card" key={entry.id}>
          <strong>
            {entry.packageId} · {entry.version}
          </strong>
          <p>
            {entry.removed ? "제거됨" : "설치됨"} · 적용 v
            {entry.installedRevision} · 블록 {entry.blockIds.length}개
          </p>
        </article>
      ))}
      <details>
        <summary>조직 업종팩 작성·등록</summary>
        <form onSubmit={register}>
          <label>
            팩 ID
            <input
              name="id"
              placeholder="brand.education"
              pattern="[a-z][a-z0-9.-]{1,99}"
              required
            />
          </label>
          <label>
            팩 이름
            <input name="name" required maxLength={100} />
          </label>
          <label>
            팩 버전
            <input
              name="version"
              defaultValue="1.0.0"
              pattern="[0-9]+\.[0-9]+\.[0-9]+"
              required
            />
          </label>
          <label>
            설명
            <textarea name="description" required maxLength={2000} />
          </label>
          <label>
            검증된 표시 유형
            <select name="template">
              <option value="cards">카드 목록</option>
              <option value="text">텍스트</option>
              <option value="faq">FAQ</option>
              <option value="pricing">가격 안내</option>
              <option value="automade:timeline">타임라인</option>
            </select>
          </label>
          <label>
            기본 제목
            <input name="title" required maxLength={1000} />
          </label>
          <label>
            기본 본문
            <textarea name="body" maxLength={50000} />
          </label>
          <button disabled={busy || !x.can("asset.manage")}>
            계약·무결성 생성 후 등록
          </button>
        </form>
      </details>
      <label>
        팩 원본 JSON 검토
        <input
          type="file"
          accept=".json"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file)
              void run(async () => {
                if (file.size > 2_000_000)
                  throw new Error("팩 원본은 2MB 이하여야 합니다.");
                const pack = parseDeclarativePackage(
                  JSON.parse(await file.text()) as unknown,
                );
                await verifyPackageIntegrity(pack);
                await prepare(pack, "install");
              });
            e.target.value = "";
          }}
        />
      </label>
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      {preview && (
        <EditorDialog
          title="업종팩 변경·권한 검토"
          onClose={() => setPreview(null)}
        >
          <p>
            모드 {String(preview.request.mode)} · 기준 문서 v
            {preview.response.baseRevision} · 필요한 권한 project.edit · 표시
            계약의 데이터와 고정 버전을 반영합니다.
          </p>
          <ChangeReview
            before={preview.before}
            after={preview.response.project}
          />
          <p>
            실행 코드와 비밀 환경 값은 설치하지 않습니다. 검토한 원본과 설치
            기록을 서버에 함께 저장합니다.
          </p>
          <button
            type="button"
            className="primary"
            disabled={busy || s.project.revision !== preview.before.revision}
            onClick={() =>
              void run(async () => {
                const response = await x.request<{ project: unknown }>(
                  "packs/apply",
                  "POST",
                  {
                    ...preview.request,
                    approvalFingerprint: preview.response.approvalFingerprint,
                  },
                );
                await s.acceptServerProject(
                  parseProject(response.project),
                  preview.before.revision,
                );
                setPreview(null);
                await refresh();
                s.setMessage("검토한 팩 변경과 원본 저장을 확인했습니다.");
              })
            }
          >
            검토한 팩 변경 적용
          </button>
        </EditorDialog>
      )}
    </details>
  );
}
