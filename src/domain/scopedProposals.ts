import type { Project } from "./types";
import {
  mergeProposal,
  minimizeProposalProject,
  type ProposalOperation,
} from "./proposals";
import { parseProject, ValidationError } from "./validation";
import { commit } from "./commands";
import { editContentRecord } from "./cms";
export interface ProposalScope {
  kind: "block" | "page" | "site" | "cms";
  targetId?: string;
  allowedFieldIds?: ("title" | "body")[];
}
export function validateProposalScope(
  project: Project,
  scope: ProposalScope,
): { blockIds: Set<string>; pageIds: Set<string> } {
  if (!["block", "page", "site", "cms"].includes(scope.kind))
    throw new ValidationError("AI 수정 범위를 선택하세요.");
  if (
    scope.allowedFieldIds?.some(
      (field) => field !== "title" && field !== "body",
    )
  )
    throw new ValidationError("AI가 수정할 수 없는 필드입니다.");
  const pages = project.pages.filter(
    (page) =>
      page.access !== "members" &&
      (scope.kind !== "page" || page.id === scope.targetId),
  );
  if (scope.kind === "page" && !pages.length)
    throw new ValidationError("공개 페이지의 수정 범위를 확인하세요.");
  const pageIds = new Set(pages.map((page) => page.id));
  const blocks = project.blocks.filter(
    (block) =>
      !block.hidden &&
      !block.locked &&
      (block.pageId === "*" || pageIds.has(block.pageId)) &&
      (scope.kind !== "block" || block.id === scope.targetId) &&
      (scope.kind !== "page" || block.pageId === scope.targetId),
  );
  if (scope.kind === "block" && !blocks.length)
    throw new ValidationError(
      "잠기거나 비공개인 블록은 외부 AI 수정에 사용할 수 없습니다.",
    );
  if (
    scope.kind === "cms" &&
    !project.collections?.some(
      (collection) =>
        collection.access !== "members" &&
        collection.records.some((record) => record.id === scope.targetId),
    )
  )
    throw new ValidationError("수정할 공개 CMS 콘텐츠를 확인하세요.");
  return {
    blockIds: new Set(
      scope.kind === "cms" ? [] : blocks.map((block) => block.id),
    ),
    pageIds,
  };
}
export function minimizeScopedProposal(
  project: Project,
  scope: ProposalScope,
): Project {
  const allowed = validateProposalScope(project, scope),
    result = minimizeProposalProject(
      project,
      scope.kind === "block" ? scope.targetId : undefined,
    );
  for (const block of result.blocks)
    if (!allowed.blockIds.has(block.id)) {
      for (const key of [
        "title",
        "body",
        "primaryAction",
        "secondaryAction",
        "navigationLabel",
        "alt",
      ] as const)
        block.props[key] = "";
      block.props.richText = undefined;
      block.props.translations = undefined;
      block.props.items = [];
      block.props.fields = [];
      block.props.columns = block.props.columns.map((column) => ({
        ...column,
        label: "",
      }));
    }
  if (scope.kind !== "site") result.settings.description = "";
  for (const page of result.pages)
    if (
      (scope.kind !== "site" &&
        !(scope.kind === "page" && page.id === scope.targetId)) ||
      !allowed.pageIds.has(page.id)
    ) {
      page.title = "";
      page.description = "";
      page.translations = undefined;
    }
  if (scope.kind === "cms")
    result.collections = project.collections
      ?.filter(
        (collection) =>
          collection.access !== "members" &&
          collection.records.some((record) => record.id === scope.targetId),
      )
      .map((collection) => ({
        id: collection.id,
        name: "",
        path: collection.path,
        records: collection.records
          .filter((record) => record.id === scope.targetId)
          .map((record) => ({
            id: record.id,
            slug: record.slug,
            title:
              !scope.allowedFieldIds || scope.allowedFieldIds.includes("title")
                ? record.title
                : "",
            body:
              !scope.allowedFieldIds || scope.allowedFieldIds.includes("body")
                ? record.body
                : "",
            category: "",
            imageId: "",
            status: "draft",
            publishedAt: "",
            fields: {},
            translations: record.translations
              ? Object.fromEntries(
                  Object.entries(record.translations).map(
                    ([language, translation]) => [
                      language,
                      {
                        title:
                          !scope.allowedFieldIds ||
                          scope.allowedFieldIds.includes("title")
                            ? (translation?.title ?? "")
                            : "",
                        body:
                          !scope.allowedFieldIds ||
                          scope.allowedFieldIds.includes("body")
                            ? (translation?.body ?? "")
                            : "",
                      },
                    ],
                  ),
                )
              : undefined,
          })),
      }));
  return result;
}
export function mergeScopedProposal(
  project: Project,
  input: unknown,
  operation: ProposalOperation,
  scope: ProposalScope,
): Project {
  const allowed = validateProposalScope(project, scope),
    proposed = parseProject(input);
  if (scope.kind === "cms") {
    if (!["copy", "tone", "translate"].includes(operation))
      throw new ValidationError(
        "CMS에는 문구와 번역 수정만 사용할 수 있습니다.",
      );
    const candidate = proposed.collections
      ?.flatMap((collection) => collection.records)
      .find((record) => record.id === scope.targetId);
    if (!candidate)
      throw new ValidationError("CMS 수정 대상이 응답에 없습니다.");
    return commit(project, (draft) => {
      for (const collection of draft.collections ?? []) {
        const index = collection.records.findIndex(
          (record) => record.id === scope.targetId,
        );
        if (index < 0) continue;
        const original = collection.records[index]!;
        collection.records[index] = editContentRecord(
          original,
          operation === "translate"
            ? {
                translations: Object.fromEntries(
                  Object.entries(candidate.translations ?? {}).map(
                    ([language, translation]) => [
                      language,
                      {
                        ...original.translations?.[language],
                        title:
                          !scope.allowedFieldIds ||
                          scope.allowedFieldIds.includes("title")
                            ? (translation?.title ?? "")
                            : (original.translations?.[language]?.title ?? ""),
                        body:
                          !scope.allowedFieldIds ||
                          scope.allowedFieldIds.includes("body")
                            ? (translation?.body ?? "")
                            : (original.translations?.[language]?.body ?? ""),
                      },
                    ],
                  ),
                ),
              }
            : {
                ...(!scope.allowedFieldIds ||
                scope.allowedFieldIds.includes("title")
                  ? { title: candidate.title }
                  : {}),
                ...(!scope.allowedFieldIds ||
                scope.allowedFieldIds.includes("body")
                  ? { body: candidate.body }
                  : {}),
              },
        );
      }
    });
  }
  const result = mergeProposal(
    project,
    proposed,
    operation,
    scope.kind === "block" ? scope.targetId : undefined,
  );
  result.blocks = result.blocks.map((block) =>
    allowed.blockIds.has(block.id)
      ? block
      : structuredClone(
          project.blocks.find((original) => original.id === block.id)!,
        ),
  );
  result.pages = result.pages.map((page) =>
    (scope.kind === "site" && allowed.pageIds.has(page.id)) ||
    (scope.kind === "page" && page.id === scope.targetId)
      ? page
      : structuredClone(
          project.pages.find((original) => original.id === page.id)!,
        ),
  );
  if (scope.kind !== "site") {
    result.settings = structuredClone(project.settings);
    result.theme = structuredClone(project.theme);
  }
  return parseProject(result);
}
