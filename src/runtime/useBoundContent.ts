import { useEffect, useState } from "react";
import type { Block, Item, Project } from "../domain/types";
import { getBoundItems } from "../domain/content";
import { record } from "../domain/validation";
type BoundItem = Item & { detailPath?: string };
export function useBoundContent(
  project: Project,
  block: Block,
  mode: "site" | "preview",
  apiBase: string,
): {
  items: BoundItem[];
  points?: { values: number[]; labels: string[]; unit: string };
  loading: boolean;
  error: string;
  enabled: boolean;
  query: string;
  setQuery: (value: string) => void;
  next: () => void;
  previous: () => void;
  reload: () => void;
  hasNext: boolean;
  hasPrevious: boolean;
  fetchedAt: string;
  cached: boolean;
} {
  const collection = project.collections?.find(
    (item) => item.id === block.props.collectionBinding?.collectionId,
  );
  const dataBinding = block.props.dataBinding;
  const enabled =
    mode === "site" &&
    Boolean(dataBinding || collection?.queryMode === "server");
  const [items, setItems] = useState<BoundItem[]>(() =>
      getBoundItems(project, block),
    ),
    [points, setPoints] = useState<
      { values: number[]; labels: string[]; unit: string } | undefined
    >(),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [fetchedAt, setFetchedAt] = useState(""),
    [cached, setCached] = useState(false),
    [query, updateQuery] = useState(""),
    [cursors, setCursors] = useState<string[]>([]),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [attempt, setAttempt] = useState(0);
  const cursor = cursors.at(-1) || "";
  const setQuery = (value: string) => {
    updateQuery(value);
    setCursors([]);
  };
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      limit: String(
        dataBinding?.limit ?? block.props.collectionBinding?.limit ?? 20,
      ),
      language: project.settings.language,
      ...(cursor ? { cursor } : {}),
      ...(query ? { q: query } : {}),
    });
    if (dataBinding) params.set("projectId", project.id);
    const path = dataBinding
      ? `api/platform/data/${encodeURIComponent(dataBinding.connectionId)}/binding`
      : `api/content/${encodeURIComponent(collection!.id)}`;
    void fetch(`${apiBase}${path}?${params}`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = record(await response.json());
        if (!response.ok)
          throw new Error(
            typeof record(body.error).message === "string"
              ? String(record(body.error).message)
              : "연결 데이터를 조회하지 못했습니다.",
          );
        const data = record(body.data);
        if (data.nextCursor !== null && typeof data.nextCursor !== "string")
          throw new Error("조회 응답의 커서를 확인하세요.");
        const rows = dataBinding ? data.rows : data.records;
        if (!Array.isArray(rows) || rows.length > 100)
          throw new Error("조회 응답의 항목 형식을 확인하세요.");
        const result = rows.map((input, index): BoundItem => {
          const row = record(input),
            title = dataBinding
              ? row[dataBinding.mapping.title ?? "title"]
              : row.title,
            body = dataBinding
              ? row[dataBinding.mapping.body ?? "body"]
              : row.body,
            image = dataBinding
              ? row[dataBinding.mapping.image ?? "imageId"]
              : row.imageId;
          if (
            !dataBinding &&
            (typeof row.id !== "string" ||
              typeof row.slug !== "string" ||
              typeof title !== "string" ||
              typeof body !== "string")
          )
            throw new Error("콘텐츠 응답의 필수 문구를 확인하세요.");
          return {
            id: typeof row.id === "string" ? row.id : `bound-${index}`,
            title: String(title ?? "").slice(0, 1000),
            body: String(body ?? "").slice(0, 50000),
            imageId:
              typeof image === "string" &&
              project.assets.some((asset) => asset.id === image)
                ? image
                : undefined,
            action: { kind: "none" },
            ...(!dataBinding && block.props.collectionBinding?.detailLinks
              ? { detailPath: `${collection!.path}/${String(row.slug)}` }
              : {}),
          };
        });
        if (active) {
          setItems(result);
          setNextCursor(data.nextCursor as string | null);
          setFetchedAt(
            typeof data.fetchedAt === "string" &&
              Number.isFinite(Date.parse(data.fetchedAt))
              ? new Date(data.fetchedAt).toISOString()
              : "",
          );
          setCached(data.cached === true);
          if (dataBinding?.mapping.value) {
            const valid = rows
              .map(record)
              .filter(
                (row) =>
                  typeof row[dataBinding.mapping.value!] === "number" &&
                  Number.isFinite(row[dataBinding.mapping.value!]),
              );
            setPoints({
              values: valid.map((row) =>
                Number(row[dataBinding.mapping.value!]),
              ),
              labels: valid.map((row) =>
                String(
                  row[
                    dataBinding.mapping.label ??
                      dataBinding.mapping.title ??
                      "label"
                  ] ?? "",
                ),
              ),
              unit: block.props.chartBinding?.unit ?? "",
            });
          }
        }
      })
      .catch((error: unknown) => {
        if (
          active &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          setItems([]);
          setPoints(undefined);
          setFetchedAt("");
          setError(
            error instanceof Error
              ? error.message
              : "연결 조회에 실패했습니다.",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    enabled,
    collection?.id,
    collection?.path,
    dataBinding,
    block.props.collectionBinding,
    block.props.chartBinding?.unit,
    apiBase,
    project.id,
    project.settings.language,
    project.assets,
    cursor,
    query,
    attempt,
  ]);
  return {
    items: enabled ? items : getBoundItems(project, block),
    points,
    loading,
    error,
    enabled,
    fetchedAt,
    cached,
    query,
    setQuery,
    hasNext: Boolean(nextCursor),
    hasPrevious: cursors.length > 0,
    next: () => {
      if (nextCursor) setCursors((values) => [...values, nextCursor]);
    },
    previous: () => setCursors((values) => values.slice(0, -1)),
    reload: () => setAttempt((value) => value + 1),
  };
}
