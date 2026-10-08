import type { Asset } from "./types";
export function assetSource(
  asset: Asset | undefined,
  apiBase = "/",
  mode: "site" | "preview" = "site",
): string {
  if (!asset) return "";
  if (asset.data) return asset.data;
  if (asset.blobRef && mode === "preview")
    return `${apiBase}api/expansion/blobs/${encodeURIComponent(asset.blobRef.id)}/content?projectId=${encodeURIComponent(asset.blobRef.projectId)}`;
  return asset.blobRef
    ? `${apiBase}assets/share-${asset.id}.${asset.mime.split("/")[1]}`
    : "";
}
