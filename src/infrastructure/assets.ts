import type { Asset } from "../domain/types";
import { uid } from "../domain/catalog";
export async function prepareAsset(
  file: File,
  compress: boolean,
  progress: (value: string) => void,
): Promise<Asset> {
  if (
    file.size > 5_000_000 ||
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)
  )
    throw new Error(
      "PNG, JPEG, WEBP, GIF 이미지만 5MB까지 사용할 수 있습니다.",
    );
  progress("이미지 검증 중");
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const signature =
    file.type === "image/png"
      ? bytes[0] === 137 &&
        bytes[1] === 80 &&
        bytes[2] === 78 &&
        bytes[3] === 71
      : file.type === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : file.type === "image/gif"
          ? String.fromCharCode(...bytes.slice(0, 3)) === "GIF"
          : String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
            String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (!signature)
    throw new Error("이미지 내용과 파일 형식이 일치하지 않습니다.");
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 40_000_000)
      throw new Error("이미지가 너무 큽니다. 4천만 픽셀 이하로 줄여주세요.");
    let blob: Blob = file,
      width = bitmap.width,
      height = bitmap.height;
    if (compress && file.type !== "image/gif") {
      progress("이미지 최적화 중");
      const ratio = Math.min(1, 2400 / Math.max(width, height));
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx)
        throw new Error("이미지 최적화를 지원하지 않는 브라우저입니다.");
      ctx.drawImage(bitmap, 0, 0, width, height);
      const optimized = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/webp", 0.85),
      );
      if (optimized && optimized.size < file.size) blob = optimized;
      else {
        width = bitmap.width;
        height = bitmap.height;
      }
    }
    progress("이미지 저장 준비 중");
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
      reader.readAsDataURL(blob);
    });
    return {
      id: uid(),
      name: file.name,
      mime: blob.type as Asset["mime"],
      data,
      alt: "",
      width,
      height,
      bytes: blob.size,
      source: "사용자 업로드",
      license: "",
    };
  } finally {
    bitmap.close();
  }
}
