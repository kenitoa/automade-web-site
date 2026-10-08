import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BlobAsset } from "../domain/expansion";
import type { Asset } from "../domain/types";
import { uid } from "../domain/catalog";
import { prepareAsset } from "../infrastructure/assets";
import { readBlobData } from "../infrastructure/blobAssets";
import type { ExpansionState } from "./useExpansion";
import type { StudioState } from "./useStudio";
import EditorDialog from "./EditorDialog";
import { useSystemActions } from "./useSystemActions";
import { api } from "../infrastructure/api";
export default function BlobAssetsPanel({
  studio: s,
  expansion: x,
}: {
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const actions = useSystemActions(s, x);
  const [assets, setAssets] = useState<BlobAsset[]>([]),
    [sourceProject, setSourceProject] = useState(s.project.id),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [progress, setProgress] = useState(""),
    [candidate, setCandidate] = useState<BlobAsset | null>(null),
    [variantSource, setVariantSource] = useState(""),
    [replaceId, setReplaceId] = useState("");
  const loadSequence = useRef(0);
  async function refresh(id = sourceProject) {
    const sequence = ++loadSequence.current;
    try {
      const result = await api<BlobAsset[]>(
        `/api/expansion/blobs?projectId=${encodeURIComponent(id)}`,
      );
      if (sequence !== loadSequence.current) return;
      setAssets(result);
      setError("");
    } catch (e) {
      if (sequence !== loadSequence.current) return;
      setError(e instanceof Error ? e.message : "공용 자산을 확인하세요.");
    }
  }
  useEffect(() => {
    setSourceProject(s.project.id);
    void refresh(s.project.id);
    return () => {
      loadSequence.current++;
    };
  }, [s.project.id]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "자산 저장소를 확인하세요.");
    } finally {
      setBusy(false);
      setProgress("");
    }
  }
  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const values = new FormData(e.currentTarget),
      file = values.get("file");
    if (!(file instanceof File) || !file.size) return;
    await run(async () => {
      if (!(await s.syncProject(s.project)))
        throw new Error("공용 자산 업로드 전에 프로젝트 동기화를 완료하세요.");
      const prepared = await prepareAsset(
        file,
        values.get("compress") === "on",
        setProgress,
      );
      const blob = await x.request<BlobAsset>("blobs", "POST", {
        projectId: s.project.id,
        dataUrl: prepared.data,
        alt: String(values.get("alt") || ""),
        source: String(values.get("source") || ""),
        license: String(values.get("license") || ""),
        ...(variantSource
          ? {
              sourceRef: variantSource,
              variantKey: String(values.get("variantKey")),
            }
          : {}),
      });
      setCandidate(blob);
      setSourceProject(s.project.id);
      await refresh(s.project.id);
      s.setMessage(
        "실제 파일 저장을 확인했습니다. 문서 연결은 사용 범위 검토 후 적용하세요.",
      );
    });
  }
  async function link() {
    if (!candidate) return;
    const projectId = s.project.id;
    let chosen = candidate;
    setBusy(true);
    setError("");
    try {
      if (chosen.projectId !== s.project.id) {
        if (!(await s.syncProject(s.project)))
          throw new Error("현재 사이트의 동기화를 먼저 완료하세요.");
        chosen = await x.request<BlobAsset>("blobs", "POST", {
          projectId: s.project.id,
          dataUrl: await readBlobData(
            {
              id: chosen.id,
              sha256: chosen.sha256,
              projectId: chosen.projectId,
            },
            chosen.mime,
          ),
          alt: chosen.alt,
          source: chosen.source,
          license: chosen.license,
        });
        if (
          chosen.inspection?.state &&
          chosen.inspection?.state !== "approved"
        ) {
          setCandidate(chosen);
          setSourceProject(projectId);
          await refresh(projectId);
          throw new Error(
            "현재 사이트에 파일을 복사했습니다. 복사본의 사용 권한·공개 범위를 승인한 뒤 연결하세요.",
          );
        }
      }
      s.apply((project) => {
        const old = project.assets.find((a) => a.id === replaceId);
        const asset: Asset = {
          id: old?.id || uid(),
          name: old?.name || `공용 이미지 ${chosen.id.slice(0, 8)}`,
          mime: chosen.mime,
          data: "",
          blobRef: {
            id: chosen.id,
            sha256: chosen.sha256,
            projectId: chosen.projectId,
          },
          alt: chosen.alt,
          source: chosen.source,
          license: chosen.license,
          width: chosen.width,
          height: chosen.height,
          bytes: chosen.bytes,
        };
        if (old) Object.assign(old, asset);
        else project.assets.push(asset);
        if (s.selectedBlock && s.selectedBlock.type === "image")
          project.blocks.find(
            (b) => b.id === s.selectedBlock?.id,
          )!.props.assetId = asset.id;
      }, projectId);
      setCandidate(null);
      s.setMessage(
        "공용 파일 참조를 연결했습니다. 원본 파일은 문서 JSON에 중복 복사하지 않습니다.",
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "공용 파일 연결 권한을 확인하세요.",
      );
    } finally {
      setBusy(false);
    }
  }
  function approval(
    asset: BlobAsset,
    state: "approved" | "rejected",
    visibility: "public" | "private",
    reason: string,
  ) {
    actions.review({
      label:
        state === "approved"
          ? "검토한 파일의 사용·공개 범위 승인"
          : "파일 사용 거절",
      path: `/api/expansion/blobs/${asset.id}/approval`,
      method: "POST",
      payload: {
        projectId: s.project.id,
        environmentId: x.environmentId,
        baseRevision: asset.inspection?.revision ?? 1,
        state,
        visibility,
        reason,
      },
      before: {
        state: asset.inspection?.state || "approved",
        visibility: asset.inspection?.visibility || "public",
        sha256: asset.sha256,
        source: asset.source,
        license: asset.license,
      },
      success: async () => {
        await refresh();
      },
    });
  }
  function resize(
    asset: BlobAsset,
    width: number,
    height: number,
    format: string,
  ) {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > asset.width ||
      height > asset.height ||
      !["png", "webp"].includes(format)
    ) {
      setError("원본 이하의 정수 크기와 PNG/WEBP 형식을 선택하세요.");
      return;
    }
    actions.review({
      label: "서버 이미지 변형 생성",
      path: `/api/expansion/blobs/${encodeURIComponent(asset.id)}/variants`,
      method: "POST",
      payload: { width, height, format, requestKey: crypto.randomUUID() },
      before: {
        sourceRef: asset.id,
        sha256: asset.sha256,
        width: asset.width,
        height: asset.height,
        mime: asset.mime,
      },
      success: async (result) => {
        const variant = result as BlobAsset;
        if (
          !variant ||
          typeof variant.id !== "string" ||
          variant.projectId !== s.project.id ||
          variant.inspection?.sourceRef !== asset.id ||
          variant.inspection.state !== "quarantined"
        )
          throw new Error("이미지 변형 응답의 원본·격리 상태를 확인하세요.");
        setCandidate(variant);
        setSourceProject(s.project.id);
        await refresh(s.project.id);
        s.setMessage(
          "서버가 실제 변형 파일을 만들었습니다. 새 파일의 출처·사용권·공개 범위를 승인한 뒤 연결하세요.",
        );
      },
    });
  }
  return (
    <details className="expansion-panel">
      <summary>조직 공용 파일 저장소</summary>
      <p className="hint">
        권한이 있는 사이트의 파일을 조회하고 실제 파일 참조로 연결합니다. 생성
        시 승인된 파일을 독립 결과물에 포함합니다.
      </p>
      <label>
        자산 출처 사이트
        <select
          value={sourceProject}
          onChange={(e) => {
            setSourceProject(e.target.value);
            void refresh(e.target.value);
          }}
        >
          <option value={s.project.id}>현재 프로젝트</option>
          {x.bootstrap?.sites
            .filter((site) => site.projectId !== s.project.id)
            .map((site) => (
              <option key={site.id} value={site.projectId}>
                {site.name}
              </option>
            ))}
        </select>
      </label>
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        공용 파일 새로고침
      </button>
      <form onSubmit={upload}>
        <label>
          파일
          <input
            name="file"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            required
          />
        </label>
        <label>
          공용 대체 텍스트
          <input name="alt" required maxLength={2000} />
        </label>
        <label>
          공용 출처
          <input name="source" maxLength={1000} />
        </label>
        <label>
          공용 사용 권한
          <input
            name="license"
            required
            maxLength={1000}
            placeholder="직접 제작 · 구매한 사용권 · 허용 라이선스"
          />
        </label>
        <label className="check">
          <input name="compress" type="checkbox" defaultChecked />
          최적화 후 저장
        </label>
        <label>
          변형 파일의 원본 (선택)
          <select
            name="sourceRef"
            value={variantSource}
            onChange={(event) => setVariantSource(event.target.value)}
          >
            <option value="">새 원본 파일</option>
            {assets
              .filter(
                (asset) =>
                  asset.projectId === s.project.id &&
                  asset.inspection?.state !== "rejected",
              )
              .map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.alt || asset.id} · {asset.width}×{asset.height}
                </option>
              ))}
          </select>
        </label>
        {variantSource && (
          <>
            <label>
              변형 키
              <input
                name="variantKey"
                required
                maxLength={80}
                placeholder="thumbnail-320"
              />
            </label>
            <p>
              원본 이하의 크기로 만든 실제 파일을 올립니다. 같은 원본·변형
              키·내용의 재요청은 같은 참조를 반환하며, 변형 파일도 별도로
              사용·공개 범위를 검토합니다.
            </p>
          </>
        )}
        <button disabled={busy || !x.can("asset.manage")}>
          공용 저장소에 업로드
        </button>
      </form>
      {progress && <p role="status">{progress}</p>}
      {!assets.length && !error && <p>조회 범위에 파일이 없습니다.</p>}
      {assets.map((asset) => (
        <article className="asset-card" key={asset.id} data-asset-id={asset.id}>
          <img
            src={`${asset.contentUrl}${asset.contentUrl.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(sourceProject)}`}
            alt={asset.alt}
          />
          <strong>{asset.alt || "대체 텍스트 미입력"}</strong>
          <small>
            {asset.width}×{asset.height} · {(asset.bytes / 1024).toFixed(1)}KB ·
            SHA256 {asset.sha256.slice(0, 12)}
          </small>
          <p>
            {asset.source} · {asset.license || "사용 권한 확인 필요"}
          </p>
          <p>
            검토 {asset.inspection?.state || "approved"} ·{" "}
            {asset.inspection?.visibility || "public"} · v
            {asset.inspection?.revision ?? 1}
            {asset.inspection?.inspection.malwareScan === "not-configured" &&
              " · 외부 악성 파일 검사 미연결"}
          </p>
          {asset.inspection?.sourceRef && (
            <small>변형 원본 {asset.inspection.sourceRef}</small>
          )}
          {sourceProject === s.project.id && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                resize(
                  asset,
                  Number(form.get("width")),
                  Number(form.get("height")),
                  String(form.get("format")),
                );
              }}
            >
              <label>
                서버 변형 너비
                <input
                  name="width"
                  type="number"
                  required
                  min={1}
                  max={asset.width}
                  defaultValue={Math.min(320, asset.width)}
                />
              </label>
              <label>
                서버 변형 높이
                <input
                  name="height"
                  type="number"
                  required
                  min={1}
                  max={asset.height}
                  defaultValue={Math.min(320, asset.height)}
                />
              </label>
              <label>
                서버 변형 형식
                <select name="format" defaultValue="webp">
                  <option value="webp">WEBP</option>
                  <option value="png">PNG</option>
                </select>
              </label>
              <p className="hint">
                원본을 보존하고 격리된 새 파일을 만듭니다. 실제 픽셀 변환 후 새
                파일도 별도로 승인합니다.
              </p>
              <button
                disabled={
                  busy ||
                  !x.can("asset.manage") ||
                  asset.inspection?.state === "rejected"
                }
              >
                서버 변형 생성 검토
              </button>
            </form>
          )}
          {sourceProject === s.project.id && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                approval(
                  asset,
                  String(form.get("state")) as "approved" | "rejected",
                  String(form.get("visibility")) as "public" | "private",
                  String(form.get("reason")),
                );
              }}
            >
              <label>
                파일 검토 결과
                <select
                  name="state"
                  defaultValue={
                    asset.inspection?.state === "rejected"
                      ? "rejected"
                      : "approved"
                  }
                >
                  <option value="approved">검토한 파일 승인</option>
                  <option value="rejected">파일 사용 거절</option>
                </select>
              </label>
              <label>
                파일 제공 범위
                <select
                  name="visibility"
                  defaultValue={asset.inspection?.visibility || "private"}
                >
                  <option value="private">비공개 편집용</option>
                  <option value="public">공개 결과물 포함 허용</option>
                </select>
              </label>
              <label>
                출처·사용권·검사 검토 사유
                <textarea name="reason" required maxLength={1000} />
              </label>
              <button disabled={busy || !x.can("asset.manage")}>
                파일 상태·범위 변경 검토
              </button>
            </form>
          )}
          <button
            type="button"
            disabled={
              !s.editable ||
              busy ||
              (asset.inspection?.state !== undefined &&
                asset.inspection?.state !== "approved")
            }
            onClick={() => {
              setReplaceId("");
              setCandidate(asset);
            }}
          >
            연결·교체 범위 검토
          </button>
          <button
            type="button"
            disabled={!x.can("asset.manage") || busy}
            onClick={() => {
              if (
                !confirm(
                  "이 사이트의 저장소 참조를 해제합니다. 사용 중인 문서와 원본 파일의 영향은 서버에서 검사합니다. 계속할까요?",
                )
              )
                return;
              void run(async () => {
                await api(
                  `/api/expansion/blobs/${asset.id}?projectId=${encodeURIComponent(sourceProject)}`,
                  "DELETE",
                );
                await refresh();
              });
            }}
          >
            저장소 참조 해제
          </button>
        </article>
      ))}
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      {candidate && (
        <EditorDialog
          title="공용 이미지 연결·교체 검토"
          onClose={() => setCandidate(null)}
        >
          <p>
            {candidate.width}×{candidate.height} ·{" "}
            {candidate.alt || "대체 텍스트 확인 필요"} · 원본 사이트{" "}
            {candidate.projectId}
          </p>
          {candidate.inspection?.state &&
            candidate.inspection?.state !== "approved" && (
              <p role="status">
                파일을 저장했고 검토 대기 상태로 격리했습니다. 이 창을 닫고 파일
                목록에서 출처·사용권·제공 범위를 검토해 승인하세요.
              </p>
            )}
          {candidate.inspection?.visibility === "private" && (
            <p>
              비공개 편집용입니다. 공개 사이트 생성에는 공개 범위 승인도
              필요합니다.
            </p>
          )}
          <label>
            문서 자산 연결
            <select
              value={replaceId}
              onChange={(e) => setReplaceId(e.target.value)}
            >
              <option value="">새 자산으로 추가</option>
              {s.project.assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.name} · 기존 연결 유지하며 교체
                </option>
              ))}
            </select>
          </label>
          <p>
            교체할 경우 이 자산을 사용하는 블록·CMS·공유 이미지가 모두 바뀝니다.{" "}
            {replaceId
              ? s.project.blocks.filter(
                  (b) =>
                    b.props.assetId === replaceId ||
                    b.props.items.some((i) => i.imageId === replaceId),
                ).length
              : 0}
            개 블록에서 사용합니다. 선택한 이미지 블록에도 연결합니다.
          </p>
          <button
            type="button"
            className="primary"
            disabled={
              !s.editable ||
              busy ||
              (candidate.inspection?.state !== undefined &&
                candidate.inspection?.state !== "approved")
            }
            onClick={() => void link()}
          >
            검토한 파일 참조 적용
          </button>
        </EditorDialog>
      )}
      {actions.dialog}
    </details>
  );
}
