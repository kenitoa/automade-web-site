import type { Block, Project, RichParagraph } from "./types";
import { parseProject } from "./validation";
import { commit } from "./commands";
export type ProposalOperation =
  "copy" | "tone" | "translate" | "layout" | "mobile";
const proseKeys = [
  "title",
  "body",
  "primaryAction",
  "secondaryAction",
  "navigationLabel",
  "alt",
] as const;
const withoutLinks = (
  paragraphs?: RichParagraph[],
): RichParagraph[] | undefined =>
  paragraphs?.map((p) => ({
    ...p,
    spans: p.spans.map(({ text, bold, italic }) => ({
      text,
      ...(bold === undefined ? {} : { bold }),
      ...(italic === undefined ? {} : { italic }),
    })),
  }));

/** The provider receives editable prose and geometry, never business data or unrelated private notes. */
export function minimizeProposalProject(
  input: Project,
  targetBlockId?: string,
): Project {
  const p = structuredClone(input);
  if (targetBlockId && !p.blocks.some((b) => b.id === targetBlockId))
    throw new Error("수정할 블록이 없습니다.");
  delete p.extensions;
  delete p.settings.brief;
  delete p.components;
  delete p.brandPacks;
  delete p.industryPacks;
  if (p.blockPackages) p.blockPackages = p.blockPackages.map((pack) => ({ ...pack, name: "", definitions: pack.definitions.map((definition) => ({ ...definition, name: "", description: "", defaults: {} })) }));
  p.assets = [];
  p.collections = [];
  p.settings.faviconAssetId = "";
  p.settings.customLanguageText = "";
  delete p.settings.siteUrl;
  if (targetBlockId) p.settings.description = "";
  p.pages = p.pages.map((page) => ({
    ...page,
    title: targetBlockId ? "" : page.title,
    description: targetBlockId ? "" : page.description,
    translations: targetBlockId ? undefined : page.translations,
    seo: undefined,
    aliases: undefined,
  }));
  p.blocks = p.blocks.map((block) => {
    const chosen = !targetBlockId || block.id === targetBlockId;
    const result = structuredClone(block);
    for (const key of proseKeys)
      result.props[key] = chosen ? block.props[key] : "";
    result.props.richText = chosen
      ? withoutLinks(block.props.richText)
      : undefined;
    result.props.translations = chosen ? block.props.translations : undefined;
    result.props.assetId = "";
    result.props.series = [];
    result.props.rows = [];
    result.props.action = { kind: "none" };
    result.props.secondary = { kind: "none" };
    delete result.props.formSettings;
    delete result.props.chartBinding;
    delete result.props.collectionBinding;
    delete result.props.dataBinding;
    delete result.componentLink;
    result.props.items = chosen
      ? result.props.items.map((i) => ({
          id: i.id,
          title: i.title,
          body: i.body,
          action: { kind: "none" },
        }))
      : [];
    result.props.fields = chosen
      ? result.props.fields.map((f) => ({ ...f, options: [] }))
      : [];
    result.props.columns = result.props.columns.map((c) => ({
      id: c.id,
      type: c.type,
      label: chosen ? c.label : "",
    }));
    return result;
  });
  return p;
}

/** Explicitly projects a validated proposal onto its allowed fields; all source contracts are retained. */
export function mergeProposal(
  input: Project,
  proposalInput: unknown,
  operation: ProposalOperation,
  targetBlockId?: string,
): Project {
  if (!["copy", "tone", "translate", "layout", "mobile"].includes(operation))
    throw new Error("지원하지 않는 수정 종류입니다.");
  if (targetBlockId && !input.blocks.some((b) => b.id === targetBlockId))
    throw new Error("수정할 블록이 없습니다.");
  if (targetBlockId && input.blocks.find((b) => b.id === targetBlockId)?.locked)
    throw new Error("잠긴 블록은 먼저 잠금을 해제하세요.");
  const proposed = parseProject(proposalInput);
  if (
    JSON.stringify(input.pages.map((p) => [p.id, p.path, p.home])) !==
      JSON.stringify(proposed.pages.map((p) => [p.id, p.path, p.home])) ||
    JSON.stringify(
      input.blocks.map((b) => [b.id, b.type, b.pageId, b.parentId]),
    ) !==
      JSON.stringify(
        proposed.blocks.map((b) => [b.id, b.type, b.pageId, b.parentId]),
      )
  )
    throw new Error("제안이 페이지 또는 블록 구조를 바꿨습니다.");
  const result = commit(input, (p) => {
    for (const original of p.blocks) {
      if (original.locked || (targetBlockId && original.id !== targetBlockId))
        continue;
      const next = proposed.blocks.find((b) => b.id === original.id)!;
      if (operation === "copy" || operation === "tone") {
        for (const key of proseKeys) original.props[key] = next.props[key];
        if (next.props.richText !== undefined)
          original.props.richText = preserveRichLinks(
            original.props.richText,
            next.props.richText,
          );
        original.props.items = original.props.items.map((item) => {
          const candidate = next.props.items.find((i) => i.id === item.id);
          return candidate
            ? { ...item, title: candidate.title, body: candidate.body }
            : item;
        });
        original.props.fields = original.props.fields.map((field) => {
          const candidate = next.props.fields.find((f) => f.id === field.id);
          return candidate
            ? {
                ...field,
                label: candidate.label,
                placeholder: candidate.placeholder,
                description: candidate.description,
              }
            : field;
        });
        original.props.columns = original.props.columns.map((column) => {
          const candidate = next.props.columns.find((c) => c.id === column.id);
          return candidate ? { ...column, label: candidate.label } : column;
        });
      } else if (operation === "translate")
        original.props.translations = structuredClone(next.props.translations);
      else if (operation === "layout") {
        original.layout = structuredClone(next.layout);
        original.design = structuredClone(next.design);
      } else {
        original.layout.responsive = structuredClone(next.layout.responsive);
        original.layout.mobileColumns = next.layout.mobileColumns;
      }
    }
    if (!targetBlockId) {
      if (operation === "copy" || operation === "tone") {
        p.settings.description = proposed.settings.description;
        for (const page of p.pages) {
          const candidate = proposed.pages.find((x) => x.id === page.id)!;
          page.title = candidate.title;
          page.description = candidate.description;
          if (page.seo && candidate.seo)
            page.seo = {
              ...page.seo,
              title: candidate.seo.title,
              description: candidate.seo.description,
            };
        }
      } else if (operation === "translate") {
        for (const page of p.pages)
          page.translations = structuredClone(
            proposed.pages.find((x) => x.id === page.id)!.translations,
          );
        const translated = new Set([
          input.settings.language,
          ...(proposed.settings.languages ?? []),
        ]);
        p.settings.languages = [...translated];
      } else if (operation === "layout")
        p.theme = structuredClone(proposed.theme);
    }
  });
  return parseProject(result);
}
function preserveRichLinks(
  before: Block["props"]["richText"],
  after: NonNullable<Block["props"]["richText"]>,
): RichParagraph[] {
  return after.map((paragraph, i) => ({
    ...paragraph,
    spans: paragraph.spans.map((span, j) => {
      const href = before?.[i]?.spans[j]?.href;
      return {
        text: span.text,
        ...(span.bold === undefined ? {} : { bold: span.bold }),
        ...(span.italic === undefined ? {} : { italic: span.italic }),
        ...(href ? { href } : {}),
      };
    }),
  }));
}
