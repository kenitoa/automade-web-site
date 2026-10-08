import { useRef, useState } from "react";
import { uid } from "../domain/catalog";
import type { Project } from "../domain/types";
import type { StudioState } from "./useStudio";
import EditorDialog from "./EditorDialog";
import ChangeReview from "./ChangeReview";
import { materializeProjectAssets } from "../infrastructure/blobAssets";
import { assetSource } from "../domain/assets";
export function AssetsPanel({ studio: s }: { studio: StudioState }) {
  const p = s.project,
    [replaceId, setReplaceId] = useState<string | undefined>(),
    [compress, setCompress] = useState(true),
    file = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="secondary full"
        onClick={() => {
          setReplaceId(undefined);
          file.current?.click();
        }}
      >
        이미지 업로드
      </button>
      <p className="hint">
        PNG · JPEG · WEBP · GIF / 각 5MB 이하. 애니메이션 GIF는 변환하지
        않습니다.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={compress}
          onChange={(e) => setCompress(e.target.checked)}
        />
        압축·최대 2400px 최적화
      </label>
      {s.assetProgress ? <p role="status">{s.assetProgress}</p> : null}
      {p.assets.map((asset) => {
        const usages = p.blocks.filter(
          (b) =>
            b.props.assetId === asset.id ||
            b.props.items.some((i) => i.imageId === asset.id),
        );
        const sharedPages = p.pages.filter(
          (page) => page.seo?.imageAssetId === asset.id,
        );
        const contentUsage = (p.collections || []).flatMap((c) =>
          c.records.filter((r) => r.imageId === asset.id),
        );
        const sectionUsage =
          p.extensions?.reusableSections?.filter((section) =>
            section.blocks.some(
              (b) =>
                b.props.assetId === asset.id ||
                b.props.items.some((i) => i.imageId === asset.id),
            ),
          ) || [];
        return (
          <article className="asset-card" key={asset.id}>
            <img src={assetSource(asset, "/", "preview")} alt={asset.alt} />
            <strong>{asset.name}</strong>
            <small>
              {asset.width || "?"}×{asset.height || "?"} ·{" "}
              {asset.bytes
                ? `${(asset.bytes / 1024).toFixed(1)}KB`
                : "기존 이미지"}
            </small>
            {(["alt", "source", "license"] as const).map((key) => (
              <label key={key}>
                {
                  {
                    alt: "대체 텍스트",
                    source: "출처",
                    license: "사용 권한·라이선스",
                  }[key]
                }
                <input
                  value={asset[key] || ""}
                  onChange={(e) =>
                    s.apply((x) => {
                      x.assets.find((a) => a.id === asset.id)![key] =
                        e.target.value;
                    })
                  }
                />
              </label>
            ))}
            <p>
              사용 {usages.length}블록
              {p.settings.faviconAssetId === asset.id ? " · 사이트 아이콘" : ""}
              {sharedPages.length ? ` · 공유 이미지 ${sharedPages.length}` : ""}
              {contentUsage.length ? ` · 콘텐츠 ${contentUsage.length}` : ""}
              {sectionUsage.length ? ` · 저장 섹션 ${sectionUsage.length}` : ""}
            </p>
            {usages.map((b) => (
              <button
                type="button"
                key={b.id}
                onClick={() => {
                  if (b.pageId !== "*") s.setPageId(b.pageId);
                  s.setSelected([b.id]);
                  s.setInspectorOpen(true);
                }}
              >
                {b.name}
              </button>
            ))}
            <div className="button-row">
              <button
                type="button"
                onClick={() => {
                  setReplaceId(asset.id);
                  file.current?.click();
                }}
              >
                이미지 교체
              </button>
              <button
                className="danger"
                type="button"
                onClick={() => {
                  if (
                    p.settings.faviconAssetId === asset.id ||
                    usages.length ||
                    sharedPages.length ||
                    sectionUsage.length ||
                    (p.collections || []).some((c) =>
                      c.records.some((r) => r.imageId === asset.id),
                    )
                  ) {
                    s.setMessage(
                      "사용 중인 이미지입니다. 블록·콘텐츠와 아이콘 연결을 먼저 해제하세요.",
                    );
                    return;
                  }
                  s.apply((x) => {
                    x.assets = x.assets.filter((a) => a.id !== asset.id);
                  });
                }}
              >
                이미지 삭제
              </button>
            </div>
          </article>
        );
      })}
      <input
        hidden
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          if (chosen) void s.addAsset(chosen, replaceId, compress);
          e.target.value = "";
        }}
      />
    </>
  );
}
export function ProjectsPanel({
  studio: s,
  onTemplates,
  onImport,
}: {
  studio: StudioState;
  onTemplates: () => void;
  onImport: () => void;
}) {
  const p = s.project,
    [query, setQuery] = useState(""),
    [archived, setArchived] = useState(false),
    [backup, setBackup] = useState<Project | null>(null);
  return (
    <>
      <div className="button-stack">
        <button type="button" className="primary" onClick={onTemplates}>
          새 프로젝트
        </button>
        <button type="button" onClick={onImport}>
          프로젝트 파일 가져오기
        </button>
        <button type="button" onClick={s.exportOriginal}>
          원본 내보내기
        </button>
        <button
          type="button"
          onClick={() => {
            void materializeProjectAssets(p)
              .then((copy) => {
                s.openProject({
                  ...copy,
                  id: uid(),
                  name: `${p.name} 복사`,
                  revision: 0,
                  updatedAt: new Date().toISOString(),
                });
                s.setLoaded(true);
              })
              .catch((error) =>
                s.setMessage(
                  error instanceof Error
                    ? error.message
                    : "공용 파일 복제 권한을 확인하세요.",
                ),
              );
          }}
        >
          프로젝트 복제
        </button>
        <button type="button" onClick={() => void s.showBackups()}>
          이전 저장본 복구
        </button>
        <button
          type="button"
          onClick={() =>
            s.apply((x) => {
              x.extensions ??= {};
              x.extensions.archived = !x.extensions.archived;
            })
          }
        >
          {p.extensions?.archived ? "프로젝트 보관 해제" : "프로젝트 보관"}
        </button>
      </div>
      <label>
        프로젝트 검색
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={archived}
          onChange={(e) => setArchived(e.target.checked)}
        />
        보관 프로젝트 포함
      </label>
      {s.restore.map((item) => (
        <button
          type="button"
          className="project-card"
          key={item.revision}
          onClick={() => setBackup(item)}
        >
          버전 {item.revision}
          <small>{new Date(item.updatedAt).toLocaleString()}</small>
        </button>
      ))}
      {s.library
        .filter(
          (x) =>
            (archived || !x.extensions?.archived) &&
            x.name.toLowerCase().includes(query.toLowerCase()),
        )
        .map((project) => (
          <button
            type="button"
            className={`project-card ${project.id === p.id ? "active" : ""}`}
            key={project.id}
            onClick={() => s.openProject(project)}
          >
            <span
              className="project-thumbnail"
              style={{
                background: project.theme.surfaceColor,
                color: project.theme.brandColor,
              }}
              aria-hidden="true"
            >
              ▰ ▱ ▱
            </span>
            <strong>
              {project.name}
              {project.extensions?.archived ? " · 보관" : ""}
            </strong>
            <small>
              {project.pages.length}페이지 · {project.blocks.length}블록 · v
              {project.revision}
            </small>
            <small>{new Date(project.updatedAt).toLocaleString()}</small>
          </button>
        ))}
      {backup ? (
        <EditorDialog
          title="이전 저장본 비교·복구"
          onClose={() => setBackup(null)}
        >
          <p>
            현재 v{p.revision} → 저장본 v{backup.revision}
          </p>
          <p>
            페이지 {p.pages.length} → {backup.pages.length}, 블록{" "}
            {p.blocks.length} → {backup.blocks.length}, 이미지 {p.assets.length}{" "}
            → {backup.assets.length}
          </p>
          <p>
            이 복구는 편집 원본만 변경합니다. 현재 원본은 백업으로 남으며 실제
            운영 문의·표 데이터는 유지합니다.
          </p>
          <details>
            <summary>원본의 변경 항목 비교</summary>
            <ChangeReview
              before={{
                name: p.name,
                settings: p.settings,
                theme: p.theme,
                pages: p.pages,
                blocks: p.blocks,
                collections: p.collections,
              }}
              after={{
                name: backup.name,
                settings: backup.settings,
                theme: backup.theme,
                pages: backup.pages,
                blocks: backup.blocks,
                collections: backup.collections,
              }}
            />
          </details>
          <button
            type="button"
            className="primary"
            onClick={() => {
              s.openProject({
                ...backup,
                revision: p.revision + 1,
                updatedAt: new Date().toISOString(),
              });
              setBackup(null);
              s.setMessage(
                "이전 원본을 복구했습니다. 현재 내용도 백업으로 보존됩니다.",
              );
            }}
          >
            확인한 저장본 복구
          </button>
        </EditorDialog>
      ) : null}
    </>
  );
}
