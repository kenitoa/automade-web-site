import type {
  Block,
  BrandPack,
  IndustryPack,
  Project,
  SharedComponent,
} from "./types";
import { commit, duplicateBlocks, insertSection } from "./commands";
import { parseProject, record, ValidationError } from "./validation";
import { createProject } from "./catalog";
import { effectiveDesign } from "./content";
import { blockReferences } from "./blockRegistry";
export interface SharedChange {
  blockId?: string;
  field: string;
  before: unknown;
  after: unknown;
}
export interface SharedPreview {
  project: Project;
  changes: SharedChange[];
  affectedIds: string[];
  skippedIds: string[];
  conflicts?: SharedConflict[];
}
export interface SharedConflict {
  blockId: string;
  field: string;
  base: unknown;
  local: unknown;
  upstream: unknown;
  reason: string;
}
function rememberComponent(project: Project, component: SharedComponent): void {
  project.componentHistory ??= [];
  const existing = project.componentHistory.find(
    (value) => value.id === component.id && value.version === component.version,
  );
  if (existing) {
    if (!sameValue(existing, component))
      throw new ValidationError(
        "공유 버전의 내용을 변경할 수 없습니다. 새 버전으로 등록하세요.",
      );
    return;
  }
  if (project.componentHistory.length >= 200)
    throw new ValidationError(
      "공유 기준 버전 보관 한도에 도달했습니다. 연결 사용처를 검토하세요.",
    );
  project.componentHistory.push(structuredClone(component));
}
function sameValue(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object")
      return `{${Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`;
    return JSON.stringify(value) ?? "undefined";
  };
  return canonical(a) === canonical(b);
}

/** Explicit structural review. Conflicts retain local values; removals detach changed or referenced blocks. */
export function previewComponentStructureUpdate(
  project: Project,
  component: SharedComponent,
  selectedIds?: string[],
): SharedPreview {
  if (!component.blocks.length)
    throw new ValidationError("공유 컴포넌트의 원본 블록이 없습니다.");
  const changes: SharedChange[] = [],
    affectedIds: string[] = [],
    skippedIds: string[] = [],
    conflicts: SharedConflict[] = [];
  const same = sameValue;
  const next = commit(project, (draft) => {
    const groups = new Map<string, Block[]>();
    for (const block of draft.blocks) {
      if (block.componentLink?.componentId !== component.id) continue;
      const instanceId = block.componentLink.instanceId;
      if (!instanceId) {
        skippedIds.push(block.id);
        continue;
      }
      const group = groups.get(instanceId) ?? [];
      group.push(block);
      groups.set(instanceId, group);
    }
    for (const [instanceId, blocks] of groups) {
      if (
        selectedIds &&
        !blocks.some((block) => selectedIds.includes(block.id))
      )
        continue;
      const version = blocks[0]!.componentLink!.version;
      const baseline = [
        ...(project.componentHistory ?? []),
        ...(project.components ?? []),
      ].find((value) => value.id === component.id && value.version === version);
      if (
        !baseline ||
        blocks.some((block) => block.componentLink?.version !== version)
      ) {
        skippedIds.push(...blocks.map((block) => block.id));
        conflicts.push({
          blockId: blocks[0]!.id,
          field: "componentLink.version",
          base: version,
          local: version,
          upstream: component.version,
          reason:
            "기준 공유본이 없거나 인스턴스 기준 버전이 다릅니다. 기존 필드 변경 검토를 사용하세요.",
        });
        continue;
      }
      if (component.version <= version) {
        if (!same(component, baseline))
          throw new ValidationError(
            "구조 업데이트는 새 공유 버전으로 검토하세요.",
          );
        continue;
      }
      const mapped = new Map(
        blocks
          .filter((block) => block.componentLink?.sourceBlockId)
          .map((block) => [block.componentLink!.sourceBlockId!, block.id]),
      );
      for (const source of component.blocks)
        if (!mapped.has(source.id)) mapped.set(source.id, crypto.randomUUID());
      const adapt = (source: Block, local?: Block, old?: Block): Block => {
        const value = structuredClone(source);
        value.id = mapped.get(source.id)!;
        value.pageId = blocks[0]!.pageId;
        value.parentId = source.parentId
          ? (mapped.get(source.parentId) ?? null)
          : null;
        value.groupId = source.groupId
          ? (mapped.get(source.groupId) ?? null)
          : null;
        const remapAction = (
          action: Block["props"]["action"],
        ): Block["props"]["action"] => {
          if (action.kind === "scroll" || action.kind === "modal")
            return mapped.has(action.target)
              ? { ...action, target: mapped.get(action.target)! }
              : { kind: "none" };
          if (
            action.kind === "navigate" &&
            !draft.pages.some((page) => page.id === action.target)
          )
            return { kind: "none" };
          return action;
        };
        value.props.action = remapAction(value.props.action);
        value.props.secondary = remapAction(value.props.secondary);
        if (value.props.formSettings)
          value.props.formSettings.successAction = remapAction(
            value.props.formSettings.successAction,
          );
        value.props.items = value.props.items.map((item) => {
          const oldIndex =
            old?.props.items.findIndex(
              (candidate) => candidate.id === item.id,
            ) ?? -1;
          return {
            ...item,
            id:
              oldIndex >= 0 && local?.props.items[oldIndex]
                ? local.props.items[oldIndex]!.id
                : crypto.randomUUID(),
            action: remapAction(item.action),
          };
        });
        if (
          value.props.chartBinding &&
          mapped.has(value.props.chartBinding.tableBlockId)
        )
          value.props.chartBinding.tableBlockId = mapped.get(
            value.props.chartBinding.tableBlockId,
          )!;
        value.componentLink = {
          componentId: component.id,
          instanceId,
          sourceBlockId: source.id,
          version: component.version,
          overrides: local?.componentLink?.overrides ?? [],
        };
        return value;
      };
      const conflict = (
        block: Block,
        field: string,
        base: unknown,
        local: unknown,
        upstream: unknown,
        reason: string,
      ) => {
        conflicts.push({
          blockId: block.id,
          field,
          base: structuredClone(base),
          local: structuredClone(local),
          upstream: structuredClone(upstream),
          reason,
        });
        skippedIds.push(block.id);
      };
      for (const source of component.blocks) {
        const local = blocks.find(
            (block) => block.componentLink?.sourceBlockId === source.id,
          ),
          old = baseline.blocks.find((block) => block.id === source.id);
        if (!local) {
          const added = adapt(source);
          draft.blocks.push(added);
          changes.push({
            blockId: added.id,
            field: "block",
            before: null,
            after: structuredClone(added),
          });
          affectedIds.push(added.id);
          continue;
        }
        if (
          !old ||
          local.type !== source.type ||
          local.locked ||
          local.componentLink?.overrides.includes("block")
        ) {
          conflict(
            local,
            "block",
            old ?? null,
            local,
            source,
            "잠금·정의 변경 또는 기준 블록 누락으로 현재 블록을 보존합니다.",
          );
          continue;
        }
        const oldMapped = adapt(old, local, old),
          upstream = adapt(source, local, old);
        const mergeField = (
          group: "props" | "design" | "layout" | null,
          key: string,
        ) => {
          const current = (group ? local[group] : local) as unknown as Record<
              string,
              unknown
            >,
            base = (group ? oldMapped[group] : oldMapped) as unknown as Record<
              string,
              unknown
            >,
            incoming = (group
              ? upstream[group]
              : upstream) as unknown as Record<string, unknown>,
            field = group ? `${group}.${key}` : key;
          if (
            same(base[key], incoming[key]) ||
            same(current[key], incoming[key])
          )
            return;
          if (
            local.componentLink?.overrides.includes(field) ||
            !same(current[key], base[key]) ||
            (group === "props" &&
              ["rows", "fields", "columns"].includes(key) &&
              ["form", "table"].includes(local.type))
          ) {
            conflict(
              local,
              field,
              base[key],
              current[key],
              incoming[key],
              "개별 수정 또는 운영 데이터 모델을 보존합니다. 별도 변경 검토가 필요합니다.",
            );
            return;
          }
          const before = structuredClone(current[key]);
          if (incoming[key] === undefined) delete current[key];
          else current[key] = structuredClone(incoming[key]);
          changes.push({
            blockId: local.id,
            field,
            before,
            after: structuredClone(incoming[key]),
          });
        };
        for (const group of ["props", "design", "layout"] as const)
          for (const field of new Set([
            ...Object.keys(oldMapped[group]),
            ...Object.keys(upstream[group]),
          ]))
            mergeField(group, field);
        for (const field of ["parentId", "groupId", "name", "hidden"])
          mergeField(null, field);
        local.componentLink!.version = component.version;
        affectedIds.push(local.id);
      }
      const removed = blocks.filter(
        (block) =>
          !component.blocks.some(
            (source) => source.id === block.componentLink?.sourceBlockId,
          ),
      );
      for (const block of removed) {
        const source = baseline.blocks.find(
          (value) => value.id === block.componentLink?.sourceBlockId,
        );
        const referenced = draft.blocks.some(
          (other) =>
            other.id !== block.id &&
            !removed.includes(other) &&
            (other.parentId === block.id ||
              blockReferences(other).some(
                (ref) => ref.type === "block" && ref.id === block.id,
              )),
        );
        const oldMapped = source ? adapt(source, block, source) : null;
        const changed =
          !oldMapped ||
          !same(block.props, oldMapped.props) ||
          !same(block.design, oldMapped.design) ||
          block.locked ||
          Boolean(block.componentLink?.overrides.length) ||
          ["form", "table"].includes(block.type);
        if (changed || referenced) {
          conflict(
            block,
            "block",
            source ?? null,
            block,
            null,
            "삭제된 공유 블록의 개별 수정·참조·운영 데이터를 보존하기 위해 연결을 해제합니다.",
          );
          changes.push({
            blockId: block.id,
            field: "componentLink",
            before: structuredClone(block.componentLink),
            after: null,
          });
          delete block.componentLink;
        } else {
          draft.blocks = draft.blocks.filter((value) => value.id !== block.id);
          changes.push({
            blockId: block.id,
            field: "block",
            before: structuredClone(block),
            after: null,
          });
          affectedIds.push(block.id);
        }
      }
      const originalOrder = baseline.blocks
          .filter((source) => mapped.has(source.id))
          .map((source) => mapped.get(source.id)),
        localOrder = blocks.map((block) => block.id);
      if (!same(originalOrder, localOrder)) {
        conflict(
          blocks[0]!,
          "blockOrder",
          originalOrder,
          localOrder,
          component.blocks.map((source) => mapped.get(source.id)),
          "개별 블록 순서를 보존합니다. 공유 순서 변경은 별도로 검토하세요.",
        );
      } else {
        const linked = draft.blocks.filter(
            (block) => block.componentLink?.instanceId === instanceId,
          ),
          ordered = component.blocks
            .map((source) =>
              linked.find(
                (block) => block.componentLink?.sourceBlockId === source.id,
              ),
            )
            .filter((block): block is Block => Boolean(block));
        let offset = 0;
        draft.blocks = draft.blocks.map((block) =>
          linked.includes(block) ? ordered[offset++]! : block,
        );
        if (
          !same(
            linked.map((block) => block.id),
            ordered.map((block) => block.id),
          )
        )
          changes.push({
            field: "blockOrder",
            before: linked.map((block) => block.id),
            after: ordered.map((block) => block.id),
          });
      }
    }
    rememberComponent(draft, component);
    draft.components ??= [];
    const index = draft.components.findIndex(
      (value) => value.id === component.id,
    );
    if (index < 0) draft.components.push(structuredClone(component));
    else draft.components[index] = structuredClone(component);
  });
  return {
    project: parseProject(next),
    changes,
    affectedIds: [...new Set(affectedIds)],
    skippedIds: [...new Set(skippedIds)],
    conflicts,
  };
}
function writableBlockField(block: Block, field: string): boolean {
  return !block.locked && !block.componentLink?.overrides.includes(field);
}
export function previewComponentUpdate(
  project: Project,
  component: SharedComponent,
  selectedIds?: string[],
): SharedPreview {
  const changes: SharedChange[] = [],
    affectedIds: string[] = [],
    skippedIds: string[] = [];
  if (!component.blocks.length)
    throw new ValidationError("공유 컴포넌트의 원본 블록이 없습니다.");
  const next = commit(project, (draft) => {
    for (const block of draft.blocks) {
      if (
        block.componentLink?.componentId !== component.id ||
        (selectedIds && !selectedIds.includes(block.id))
      )
        continue;
      const source = block.componentLink.sourceBlockId
        ? component.blocks.find(
            (item) => item.id === block.componentLink?.sourceBlockId,
          )
        : component.blocks.length === 1
          ? component.blocks[0]
          : undefined;
      if (!source) {
        skippedIds.push(block.id);
        continue;
      }
      if (block.type !== source.type || block.locked) {
        skippedIds.push(block.id);
        continue;
      }
      for (const [group, keys] of [
        [
          "props",
          [
            "title",
            "body",
            "primaryAction",
            "secondaryAction",
            "alt",
            "richText",
            "imageSettings",
          ],
        ],
        ["design", Object.keys(source.design)],
        ["layout", ["columns", "gap", "align", "mobileColumns", "responsive"]],
      ] as const)
        for (const key of keys) {
          const field = `${group}.${key}`;
          if (!writableBlockField(block, field)) continue;
          const before = (block[group] as unknown as Record<string, unknown>)[
              key
            ],
            after = (source[group] as unknown as Record<string, unknown>)[key];
          if (JSON.stringify(before) === JSON.stringify(after)) continue;
          (block[group] as unknown as Record<string, unknown>)[key] =
            structuredClone(after);
          changes.push({ blockId: block.id, field, before, after });
        }
      if (writableBlockField(block, "props.items")) {
        const updatedItems = source.props.items.map((item, index) => ({
          ...structuredClone(
            block.props.items[index] ?? {
              id: crypto.randomUUID(),
              action: { kind: "none" as const },
            },
          ),
          title: item.title,
          body: item.body,
        }));
        if (
          JSON.stringify(updatedItems) !== JSON.stringify(block.props.items)
        ) {
          changes.push({
            blockId: block.id,
            field: "props.items",
            before: block.props.items,
            after: updatedItems,
          });
          block.props.items = updatedItems;
        }
      }
      if (
        writableBlockField(block, "props.assetId") &&
        (!source.props.assetId ||
          draft.assets.some((asset) => asset.id === source.props.assetId)) &&
        source.props.assetId !== block.props.assetId
      ) {
        changes.push({
          blockId: block.id,
          field: "props.assetId",
          before: block.props.assetId,
          after: source.props.assetId,
        });
        block.props.assetId = source.props.assetId;
      }
      block.componentLink.version = component.version;
      affectedIds.push(block.id);
    }
    draft.components ??= [];
    const index = draft.components.findIndex(
      (item) => item.id === component.id,
    );
    if (index < 0) draft.components.push(structuredClone(component));
    else draft.components[index] = structuredClone(component);
  });
  return { project: next, changes, affectedIds, skippedIds };
}
export function instantiateComponent(
  project: Project,
  component: SharedComponent,
  pageId: string,
): Project {
  if (!component.blocks.length)
    throw new ValidationError("공유 컴포넌트의 블록이 없습니다.");
  const temporary = { ...project, blocks: component.blocks },
    copied = duplicateBlocks(
      temporary,
      component.blocks.map((block) => block.id),
    );
  const newBlocks = copied.blocks.slice(component.blocks.length);
  const instanceId = crypto.randomUUID();
  return commit(project, (draft) => {
    draft.blocks.push(
      ...newBlocks.map((block, index) => ({
        ...block,
        pageId,
        componentLink: {
          componentId: component.id,
          instanceId,
          sourceBlockId: component.blocks[index]!.id,
          version: component.version,
          overrides: [],
        },
      })),
    );
    draft.components ??= [];
    if (!draft.components.some((item) => item.id === component.id))
      draft.components.push(structuredClone(component));
    rememberComponent(draft, component);
  });
}
export function detachComponent(project: Project, ids: string[]): Project {
  return commit(project, (draft) => {
    for (const block of draft.blocks)
      if (ids.includes(block.id)) delete block.componentLink;
  });
}
export function setComponentOverride(
  project: Project,
  blockId: string,
  field: string,
  overridden: boolean,
): Project {
  return commit(project, (draft) => {
    const block = draft.blocks.find((block) => block.id === blockId);
    if (!block?.componentLink)
      throw new ValidationError("연결된 컴포넌트 블록을 선택하세요.");
    const fields = new Set(block.componentLink.overrides);
    if (overridden) fields.add(field);
    else fields.delete(field);
    block.componentLink.overrides = [...fields];
  });
}
export function previewBrandUpdate(
  project: Project,
  brand: BrandPack,
  selectedBlockIds?: string[],
): SharedPreview {
  const changes: SharedChange[] = [],
    affectedIds: string[] = [],
    skippedIds: string[] = [];
  const next = commit(project, (draft) => {
    if (!selectedBlockIds) {
      for (const key of Object.keys(brand.theme))
        changes.push({
          field: `theme.${key}`,
          before: draft.theme[key as keyof Project["theme"]],
          after: brand.theme[key as keyof Project["theme"]],
        });
      draft.theme = structuredClone(brand.theme);
    }
    for (const block of draft.blocks) {
      if (selectedBlockIds && !selectedBlockIds.includes(block.id)) continue;
      if (
        block.locked ||
        block.design.themeMode !== "theme" ||
        block.componentLink?.overrides.some((field) =>
          field.startsWith("design."),
        )
      ) {
        if (!selectedBlockIds && block.design.themeMode === "theme") {
          const before = structuredClone(block.design),
            preserved = effectiveDesign(project, block);
          block.design = {
            ...preserved,
            themeMode: "custom",
            fontSize: preserved.fontSize ?? 16,
            headingSize:
              preserved.headingSize ?? (block.type === "hero" ? 48 : 32),
            lineHeight: preserved.lineHeight ?? 1.65,
          };
          changes.push({
            blockId: block.id,
            field: "design",
            before,
            after: block.design,
          });
        }
        skippedIds.push(block.id);
        continue;
      }
      if (selectedBlockIds) {
        changes.push({
          blockId: block.id,
          field: "design.background",
          before: block.design.background,
          after: brand.theme.surfaceColor,
        });
        block.design = {
          ...block.design,
          themeMode: "custom",
          background: brand.theme.surfaceColor,
          radius: brand.theme.radius,
          fontSize: brand.theme.typography?.bodySize,
          headingSize: brand.theme.typography?.headingSize,
          lineHeight: brand.theme.typography?.lineHeight,
        };
      }
      affectedIds.push(block.id);
    }
    draft.brandPacks ??= [];
    const index = draft.brandPacks.findIndex((item) => item.id === brand.id);
    if (index < 0) draft.brandPacks.push(structuredClone(brand));
    else draft.brandPacks[index] = structuredClone(brand);
  });
  return { project: next, changes, affectedIds, skippedIds };
}
export function parseSharedComponent(value: unknown): SharedComponent {
  const input = record(value);
  if (
    typeof input.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(input.id) ||
    typeof input.name !== "string" ||
    input.name.length > 200 ||
    typeof input.version !== "number" ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    !Array.isArray(input.blocks) ||
    !input.blocks.length ||
    input.blocks.length > 1000
  )
    throw new ValidationError("공유 컴포넌트 계약을 확인하세요.");
  const base = createProject();
  const project = parseProject({
    ...base,
    blocks: input.blocks.map((value) => ({
      ...record(value),
      pageId: base.pages[0]!.id,
    })),
  });
  return {
    id: input.id,
    name: input.name,
    version: input.version,
    blocks: project.blocks,
  };
}
export function previewIndustryPack(
  project: Project,
  pack: IndustryPack,
  pageId: string,
  selectedSectionIds: string[],
): SharedPreview {
  if (!project.pages.some((page) => page.id === pageId))
    throw new ValidationError("업종 팩을 적용할 페이지를 선택하세요.");
  const sections = pack.sections.filter((section) =>
    selectedSectionIds.includes(section.id),
  );
  if (sections.length !== new Set(selectedSectionIds).size)
    throw new ValidationError("업종 팩의 섹션 선택을 확인하세요.");
  let next = structuredClone(project);
  const originalSections = structuredClone(
      next.extensions?.reusableSections ?? [],
    ),
    beforeIds = new Set(next.blocks.map((block) => block.id));
  next.extensions ??= {};
  next.extensions.reusableSections = sections;
  for (const section of sections)
    next = insertSection(next, section.id, pageId);
  next.extensions ??= {};
  next.extensions.reusableSections = originalSections;
  next.industryPacks = [
    ...(next.industryPacks ?? []).filter((item) => item.id !== pack.id),
    structuredClone(pack),
  ];
  const affectedIds = next.blocks
    .filter((block) => !beforeIds.has(block.id))
    .map((block) => block.id);
  return {
    project: parseProject(next),
    changes: affectedIds.map((blockId) => ({
      blockId,
      field: "block",
      before: null,
      after: next.blocks.find((block) => block.id === blockId),
    })),
    affectedIds,
    skippedIds: [],
  };
}
