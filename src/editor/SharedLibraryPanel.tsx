import { useEffect, useState } from "react";
import type { ExpansionBrand, ExpansionLibraryItem } from "../domain/expansion";
import type { SharedComponent, Project } from "../domain/types";
import { uid } from "../domain/catalog";
import { historyChange } from "../domain/commands";
import { parseProject, record } from "../domain/validation";
import {
  instantiateComponent,
  previewComponentUpdate,
  previewComponentStructureUpdate,
  previewBrandUpdate,
  parseSharedComponent,
  type SharedPreview,
} from "../domain/shared";
import type { ExpansionState } from "./useExpansion";
import type { StudioState } from "./useStudio";
import EditorDialog from "./EditorDialog";
import ChangeReview from "./ChangeReview";
export default function SharedLibraryPanel({
  studio: s,
  expansion: x,
}: {
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const [brands, setBrands] = useState<ExpansionBrand[]>([]),
    [items, setItems] = useState<ExpansionLibraryItem[]>([]),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<{
      project: Project;
      before: Project;
      label: string;
      affected: number;
      skipped: number;
      conflicts: NonNullable<SharedPreview["conflicts"]>;
    } | null>(null),
    [selectedOnly, setSelectedOnly] = useState(false);
  const [brandHistory, setBrandHistory] = useState<{
      brand: ExpansionBrand;
      versions: {
        revision: number;
        theme: Project["theme"];
        createdAt: string;
      }[];
    } | null>(null),
    [restoreBrand, setRestoreBrand] = useState<{
      brand: ExpansionBrand;
      revision: number;
      theme: Project["theme"];
    } | null>(null);
  async function refresh() {
    try {
      const [brands, items] = await Promise.all([
        x.request<ExpansionBrand[]>("brands"),
        x.request<ExpansionLibraryItem[]>("library"),
      ]);
      setBrands(brands);
      setItems(items);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "공용 라이브러리를 확인하세요.",
      );
    }
  }
  useEffect(() => {
    void refresh();
  }, [x.scope?.organizationId]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "공유 자료를 확인하세요.");
    } finally {
      setBusy(false);
    }
  }
  function selectedBlocks() {
    const ids = new Set(s.selected);
    let changed = true;
    while (changed) {
      changed = false;
      for (const block of s.project.blocks)
        if (block.parentId && ids.has(block.parentId) && !ids.has(block.id)) {
          ids.add(block.id);
          changed = true;
        }
    }
    return s.project.blocks
      .filter((block) => ids.has(block.id))
      .map((block) => ({
        ...structuredClone(block),
        parentId:
          block.parentId && ids.has(block.parentId) ? block.parentId : null,
      }));
  }
  function component(item: ExpansionLibraryItem): SharedComponent {
    return parseSharedComponent(item.body);
  }
  function show(label: string, value: SharedPreview | Project) {
    const wrapped = "project" in value ? value : null;
    setPreview({
      project: wrapped ? wrapped.project : (value as Project),
      before: structuredClone(s.project),
      label,
      affected: wrapped ? wrapped.affectedIds.length : 0,
      skipped: wrapped ? wrapped.skippedIds.length : 0,
      conflicts: wrapped?.conflicts || [],
    });
  }
  const review = (action: () => void) => {
    try {
      action();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "적용 영향을 확인하세요.");
    }
  };
  return (
    <details className="expansion-panel">
      <summary>조직 공용 브랜드·연결 컴포넌트</summary>
      <label>
        공유 자료 이름
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
        />
      </label>
      <div className="button-row">
        <button
          type="button"
          disabled={busy || !name.trim() || !x.can("asset.manage")}
          onClick={() =>
            void run(() =>
              x.request("brands", "POST", {
                organizationId: x.scope?.organizationId,
                name,
                theme: s.project.theme,
              }),
            )
          }
        >
          현재 테마를 브랜드 버전으로 등록
        </button>
        <button
          type="button"
          disabled={
            busy || !name.trim() || !s.selected.length || !x.can("asset.manage")
          }
          onClick={() =>
            void run(() =>
              x.request("library", "POST", {
                organizationId: x.scope?.organizationId,
                kind: "component",
                name,
                body: { id: uid(), name, version: 1, blocks: selectedBlocks() },
              }),
            )
          }
        >
          선택 영역을 공용 컴포넌트 등록
        </button>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={selectedOnly}
          onChange={(e) => setSelectedOnly(e.target.checked)}
        />
        선택 블록만 변경 검토
      </label>
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        공용 자료 새로고침
      </button>
      {brands.map((brand) => (
        <article className="page-card" key={brand.id}>
          <strong>
            {brand.name} · v{brand.revision}
          </strong>
          <p>공용 저장본 · {new Date(brand.updatedAt).toLocaleString()}</p>
          <p>
            {brand.publishedRevision
              ? `공유 공개 v${brand.publishedRevision} · 현재 v${brand.revision}`
              : "현재 버전은 공유 초안입니다"}
          </p>
          <div className="button-row">
            <button
              type="button"
              disabled={busy || !x.can("asset.manage")}
              onClick={() => {
                if (
                  !confirm(
                    `${brand.name} v${brand.revision}을 조직 공유 공개 버전으로 지정합니다. 각 사이트는 변경 영향 검토 후 적용합니다.`,
                  )
                )
                  return;
                void run(() =>
                  x.request(`brands/${brand.id}/publish`, "POST", {
                    organizationId: brand.organizationId,
                    baseRevision: brand.revision,
                  }),
                );
              }}
            >
              현재 초안 공유 공개
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const rows = await x.request<unknown[]>(
                    `brands/${brand.id}/versions?organizationId=${brand.organizationId}`,
                  );
                  setBrandHistory({
                    brand,
                    versions: rows.map((value) => {
                      const row = record(value);
                      if (
                        typeof row.revision !== "number" ||
                        typeof row.createdAt !== "string"
                      )
                        throw new Error("브랜드 버전 계약을 확인하세요.");
                      return {
                        revision: row.revision,
                        createdAt: row.createdAt,
                        theme: parseProject({ ...s.project, theme: row.theme })
                          .theme,
                      };
                    }),
                  });
                })
              }
            >
              브랜드 버전 이력·복원
            </button>
            <button
              type="button"
              disabled={!s.editable}
              onClick={() =>
                review(() =>
                  show(
                    `${brand.name} 브랜드 적용`,
                    previewBrandUpdate(
                      s.project,
                      {
                        id: brand.id,
                        name: brand.name,
                        version: brand.revision,
                        theme: parseProject({
                          ...s.project,
                          theme: brand.theme,
                        }).theme,
                      },
                      selectedOnly ? s.selected : undefined,
                    ),
                  ),
                )
              }
            >
              브랜드 변경 영향 검토
            </button>
            <button
              type="button"
              disabled={busy || !x.can("asset.manage")}
              onClick={() =>
                void run(() =>
                  x.request(`brands/${brand.id}`, "PUT", {
                    organizationId: brand.organizationId,
                    name: brand.name,
                    theme: s.project.theme,
                    baseRevision: brand.revision,
                  }),
                )
              }
            >
              현재 테마를 다음 버전으로 저장
            </button>
          </div>
        </article>
      ))}
      {items
        .filter((item) => item.kind === "component")
        .map((item) => (
          <article className="page-card" key={item.id}>
            <strong>
              {item.name} · 라이브러리 v{item.revision}
            </strong>
            <div className="button-row">
              <button
                type="button"
                disabled={!s.editable}
                onClick={() =>
                  review(() =>
                    show(
                      `${item.name} 연결 인스턴스 삽입`,
                      instantiateComponent(
                        s.project,
                        component(item),
                        s.pageId,
                      ),
                    ),
                  )
                }
              >
                연결 삽입 검토
              </button>
              <button
                type="button"
                disabled={!s.editable}
                onClick={() =>
                  review(() =>
                    show(
                      `${item.name} 연결 업데이트`,
                      previewComponentUpdate(
                        s.project,
                        component(item),
                        selectedOnly ? s.selected : undefined,
                      ),
                    ),
                  )
                }
              >
                사용 인스턴스 업데이트 검토
              </button>
              <button
                type="button"
                disabled={!s.editable}
                onClick={() =>
                  review(() =>
                    show(
                      `${item.name} 구조·개별 수정 비교`,
                      previewComponentStructureUpdate(
                        s.project,
                        component(item),
                        selectedOnly ? s.selected : undefined,
                      ),
                    ),
                  )
                }
              >
                구조 변경·개별 수정 비교
              </button>
              <button
                type="button"
                disabled={busy || !s.selected.length || !x.can("asset.manage")}
                onClick={() =>
                  void run(() => {
                    const current = component(item);
                    return x.request(`library/${item.id}`, "PUT", {
                      organizationId: item.organizationId,
                      kind: item.kind,
                      name: item.name,
                      baseRevision: item.revision,
                      body: {
                        ...current,
                        version: current.version + 1,
                        blocks: selectedBlocks(),
                      },
                    });
                  })
                }
              >
                선택 영역을 다음 원본 버전으로 저장
              </button>
            </div>
          </article>
        ))}
      {!brands.length && !items.length && !busy && (
        <p>
          등록된 공용 자료가 없습니다. 현재 테마 또는 선택 영역을 등록하세요.
        </p>
      )}
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      {preview && (
        <EditorDialog title={preview.label} onClose={() => setPreview(null)}>
          <p>
            영향 블록 {preview.affected}개 · 잠금·개별 지정 제외{" "}
            {preview.skipped}개
          </p>
          <ChangeReview before={preview.before} after={preview.project} />
          {preview.conflicts.length > 0 && (
            <section aria-label="공유 구조 충돌 검토">
              <h3>사용자 수정 보존·상위 변경 충돌</h3>
              <p>
                개별 수정과 삭제·참조 충돌은 현재 자료를 보존한 상태로
                제안합니다. 공유 원본과 비교하고 추가 수정은 적용 후 원본에서
                수행하세요.
              </p>
              {preview.conflicts.map((conflict, index) => (
                <article
                  className="page-card"
                  key={`${conflict.blockId}:${conflict.field}:${index}`}
                >
                  <strong>
                    {conflict.field} · {conflict.reason}
                  </strong>
                  <table>
                    <caption>기준·현재 편집·새 공유 원본</caption>
                    <thead>
                      <tr>
                        <th>기준</th>
                        <th>현재 편집</th>
                        <th>새 공유 원본</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>
                          <pre>
                            {JSON.stringify(conflict.base, null, 2) ?? "없음"}
                          </pre>
                        </td>
                        <td>
                          <pre>
                            {JSON.stringify(conflict.local, null, 2) ?? "없음"}
                          </pre>
                        </td>
                        <td>
                          <pre>
                            {JSON.stringify(conflict.upstream, null, 2) ??
                              "없음"}
                          </pre>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </article>
              ))}
            </section>
          )}
          <p>
            현재 문서에만 적용합니다. 다른 사이트는 해당 원본 버전을 별도로
            검토·적용해야 합니다.
          </p>
          <button
            type="button"
            className="primary"
            disabled={
              !s.editable || s.project.revision !== preview.before.revision
            }
            onClick={() => {
              s.setHistory((h) => historyChange(h, preview.project));
              setPreview(null);
              s.setMessage(
                "검토한 공유 자료를 원본에 적용했습니다. 한 번의 실행 취소로 복구할 수 있습니다.",
              );
            }}
          >
            검토한 변경 적용
          </button>
        </EditorDialog>
      )}
      {brandHistory && (
        <EditorDialog
          title="보존된 브랜드 버전"
          onClose={() => setBrandHistory(null)}
        >
          <p>
            {brandHistory.brand.name} · 현재 v{brandHistory.brand.revision} ·
            공개 v{brandHistory.brand.publishedRevision || "미공개"}
          </p>
          {brandHistory.versions.map((version) => (
            <article className="page-card" key={version.revision}>
              <strong>브랜드 v{version.revision}</strong>
              <small>{new Date(version.createdAt).toLocaleString()}</small>
              <button
                type="button"
                onClick={() => {
                  setRestoreBrand({
                    brand: brandHistory.brand,
                    revision: version.revision,
                    theme: version.theme,
                  });
                  setBrandHistory(null);
                }}
              >
                이 버전 복원 변경 검토
              </button>
            </article>
          ))}
        </EditorDialog>
      )}
      {restoreBrand && (
        <EditorDialog
          title="브랜드 과거 버전을 새 초안으로 복원"
          onClose={() => setRestoreBrand(null)}
        >
          <p>
            보존 v{restoreBrand.revision}의 토큰을 현재 v
            {restoreBrand.brand.revision} 뒤에 새 버전으로 저장합니다. 이전
            이력과 사이트 적용 내용은 보존합니다.
          </p>
          <ChangeReview
            before={restoreBrand.brand.theme}
            after={restoreBrand.theme}
          />
          <button
            type="button"
            disabled={busy || !x.can("asset.manage")}
            onClick={() =>
              void run(async () => {
                await x.request(`brands/${restoreBrand.brand.id}`, "PUT", {
                  organizationId: restoreBrand.brand.organizationId,
                  name: restoreBrand.brand.name,
                  theme: restoreBrand.theme,
                  baseRevision: restoreBrand.brand.revision,
                });
                setRestoreBrand(null);
                s.setMessage(
                  "과거 브랜드 토큰을 새 초안 버전으로 저장했습니다. 공유 공개와 각 사이트 적용을 검토하세요.",
                );
              })
            }
          >
            검토한 토큰을 새 버전으로 저장
          </button>
        </EditorDialog>
      )}
    </details>
  );
}
