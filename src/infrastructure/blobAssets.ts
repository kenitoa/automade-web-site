import type { Asset, Project } from "../domain/types";
export async function readBlobData(
  reference: NonNullable<Asset["blobRef"]>,
  mime: Asset["mime"],
): Promise<string> {
  const response = await fetch(
    `/api/expansion/blobs/${encodeURIComponent(reference.id)}/content?projectId=${encodeURIComponent(reference.projectId)}`,
    { credentials: "same-origin", signal: AbortSignal.timeout(15000) },
  );
  if (
    !response.ok ||
    response.headers.get("Content-Type")?.split(";")[0] !== mime
  )
    throw new Error("공용 원본 파일의 조회 권한과 이미지 형식을 확인하세요.");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 8000000)
    throw new Error("공용 원본 파일이 8MB를 초과합니다.");
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== reference.sha256)
    throw new Error("공용 원본 파일의 해시가 다릅니다. 복제를 중단했습니다.");
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(new Error("공용 원본 파일을 읽지 못했습니다."));
    reader.readAsDataURL(new Blob([bytes], { type: mime }));
  });
}
export async function materializeProjectAssets(
  project: Project,
): Promise<Project> {
  const copy = structuredClone(project);
  for (const asset of copy.assets)
    if (asset.blobRef) {
      asset.data = await readBlobData(asset.blobRef, asset.mime);
      delete asset.blobRef;
    }
  return copy;
}
