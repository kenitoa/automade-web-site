import { CATALOG } from "./catalog";
import { normalizeLanguage } from "./languages";
import { enrichContentState } from "./contentState";
import { parseCmsSchema, parseCmsValues, parseContentWorkflow } from "./cms";
import { parseDeclarativePackage, parseFeaturePin } from "./packages";
import {
  parseAction,
  parseProject,
  record,
  safeUrl,
  ValidationError,
} from "./validation";
import type {
  Block,
  ContentCollection,
  ContentRecord,
  Project,
  ResponsiveStyle,
  SiteLanguage,
} from "./types";

const str = (v: unknown, max = 2000): string => {
  if (typeof v !== "string") return "";
  if (v.length > max)
    throw new ValidationError(`문자열은 ${max}자 이하여야 합니다.`);
  return v;
};
const num = (
  v: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    throw new ValidationError(`수치는 ${min}~${max} 범위여야 합니다.`);
  return v;
};
const bool = (v: unknown, fallback = false): boolean => {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean")
    throw new ValidationError("참 또는 거짓 값을 입력하세요.");
  return v;
};
const arr = (v: unknown, max: number): unknown[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max)
    throw new ValidationError(`목록은 최대 ${max}개여야 합니다.`);
  return v;
};
const identifier = (v: unknown): string => {
  const result = str(v, 100);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(result))
    throw new ValidationError("올바른 ID가 필요합니다.");
  return result;
};
const path = (v: unknown): string => {
  const result = str(v, 200);
  if (
    !/^\/(?:[a-zA-Z0-9_-]+\/?)*$/.test(result) ||
    /^\/(api|assets|health)(\/|$)/.test(result)
  )
    throw new ValidationError("올바른 콘텐츠 경로를 입력하세요.");
  return result === "/" ? "/" : result.replace(/\/$/, "");
};
const unique = (values: string[], label: string) => {
  if (new Set(values).size !== values.length)
    throw new ValidationError(`${label}이 중복됩니다.`);
};
const responsive = (v: unknown): ResponsiveStyle => {
  const r = record(v);
  const parsed = Object.fromEntries(
    (["columns", "gap", "padding", "fontSize", "headingSize"] as const)
      .filter((k) => r[k] !== undefined)
      .map((k) => [
        k,
        num(
          r[k],
          0,
          k === "columns" ? 1 : k.includes("Size") ? 10 : 0,
          k === "columns" ? 12 : k.includes("Size") ? 160 : 200,
        ),
      ]),
  );
  if (parsed.columns !== undefined && !Number.isInteger(parsed.columns))
    throw new ValidationError("반응형 열 개수는 정수여야 합니다.");
  return parsed;
};
function translated<T>(
  v: unknown,
  parse: (value: Record<string, unknown>) => T,
): Partial<Record<SiteLanguage, T>> {
  const r = record(v);
  if (Object.keys(r).length > 30)
    throw new ValidationError("번역 언어는 최대 30개입니다.");
  const entries = Object.entries(r).map(
    ([lang, value]) => [normalizeLanguage(lang), parse(record(value))] as const,
  );
  unique(
    entries.map(([lang]) => lang),
    "번역 언어",
  );
  return Object.fromEntries(entries);
}

/** Only explicit additive fields are accepted; legacy v2 documents keep their behavior. */
export function enhanceProject(p: Project, value: unknown): void {
  const raw = record(value),
    settings = record(raw.settings),
    theme = record(raw.theme);
  if (raw.featurePins !== undefined) {
    p.featurePins = arr(raw.featurePins, 100).map(parseFeaturePin);
    unique(
      p.featurePins.map((pin) => pin.packageId),
      "패키지 고정 ID",
    );
  }
  if (raw.blockPackages !== undefined) {
    p.blockPackages = arr(raw.blockPackages, 100).map(parseDeclarativePackage);
    unique(
      p.blockPackages.map((pack) => pack.id),
      "패키지 ID",
    );
  }
  if (settings.brief !== undefined) {
    const b = record(settings.brief);
    if (
      !["business", "portfolio", "service", "workspace"].includes(
        String(b.purpose),
      )
    )
      throw new ValidationError("사이트 목적을 선택하세요.");
    p.settings.brief = {
      purpose: b.purpose as NonNullable<
        Project["settings"]["brief"]
      >["purpose"],
      audience: str(b.audience),
      primaryGoal: str(b.primaryGoal),
      tone: str(b.tone, 200),
      materials: arr(b.materials, 100).map((x) => str(x)),
    };
  }
  if (settings.siteUrl !== undefined) {
    const url = str(settings.siteUrl, 2048);
    if (url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new ValidationError("대표 사이트 URL을 확인하세요.");
      }
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        (parsed.pathname !== "/" && parsed.pathname !== "")
      )
        throw new ValidationError(
          "대표 사이트는 경로 없는 HTTPS URL이어야 합니다.",
        );
      p.settings.siteUrl = parsed.origin;
    } else p.settings.siteUrl = "";
  }
  if (settings.languages !== undefined) {
    p.settings.languages = arr(settings.languages, 30).map(normalizeLanguage);
    unique(p.settings.languages, "언어");
  }
  if (settings.languageFallbacks !== undefined) {
    const pairs = Object.entries(record(settings.languageFallbacks));
    if (pairs.length > 30)
      throw new ValidationError("대체 언어는 최대 30개입니다.");
    p.settings.languageFallbacks = Object.fromEntries(
      pairs.map(([key, value]) => [
        normalizeLanguage(key),
        normalizeLanguage(value),
      ]),
    );
    for (const start of Object.keys(p.settings.languageFallbacks)) {
      const seen = new Set<string>();
      let key: string | undefined = start;
      while (key) {
        if (seen.has(key))
          throw new ValidationError("대체 언어 연결에 순환이 있습니다.");
        seen.add(key);
        key = p.settings.languageFallbacks[key];
      }
    }
  }
  if (theme.typography !== undefined) {
    const t = record(theme.typography);
    p.theme.typography = {
      bodySize: num(t.bodySize, 16, 10, 48),
      headingSize: num(t.headingSize, 48, 16, 160),
      lineHeight: num(t.lineHeight, 1.65, 1, 3),
      sectionGap: num(t.sectionGap, 24, 0, 200),
      contentWidth: num(t.contentWidth, 1200, 320, 10000),
    };
  }
  if (theme.button !== undefined) {
    const t = record(theme.button);
    p.theme.button = {
      radius: num(t.radius, 9, 0, 100),
      padding: num(t.padding, 10, 0, 100),
    };
  }
  arr(raw.pages, 100).forEach((v, i) => {
    const r = record(v),
      page = p.pages[i]!;
    if (r.access !== undefined) {
      if (r.access !== "public" && r.access !== "members")
        throw new ValidationError("페이지 접근 권한을 확인하세요.");
      if (page.home && r.access === "members")
        throw new ValidationError("홈 페이지는 공개 페이지여야 합니다.");
      page.access = r.access;
    }
    if (r.navigation !== undefined) page.navigation = bool(r.navigation, true);
    if (r.aliases !== undefined) page.aliases = arr(r.aliases, 100).map(path);
    if (r.seo !== undefined) {
      const s = record(r.seo);
      page.seo = {
        title: str(s.title, 200),
        description: str(s.description, 2000),
        imageAssetId: str(s.imageAssetId, 100),
        noIndex: bool(s.noIndex),
      };
    }
    if (r.translations !== undefined)
      page.translations = translated(r.translations, (t) => ({
        title: str(t.title, 200),
        description: str(t.description),
      }));
  });
  unique(
    p.pages.flatMap((page) => [page.path, ...(page.aliases ?? [])]),
    "페이지 경로",
  );
  arr(raw.assets, 100).forEach((v, i) => {
    const r = record(v),
      asset = p.assets[i]!;
    for (const key of ["width", "height", "bytes"] as const)
      if (r[key] !== undefined)
        asset[key] = num(r[key], 0, 0, key === "bytes" ? 8_000_000 : 50000);
    for (const key of ["source", "license", "blobId"] as const)
      if (r[key] !== undefined) asset[key] = str(r[key]);
  });
  arr(raw.blocks, 1000).forEach((v, i) => enhanceBlock(p.blocks[i]!, v));
  if (raw.collections !== undefined) {
    p.collections = arr(raw.collections, 100).map((v) => {
      const c = record(v);
      if (
        c.access !== undefined &&
        c.access !== "public" &&
        c.access !== "members"
      )
        throw new ValidationError("콘텐츠 접근 권한을 확인하세요.");
      const collection: ContentCollection = {
        id: identifier(c.id),
        name: str(c.name, 200),
        path: path(c.path),
        ...(c.access ? { access: c.access as "public" | "members" } : {}),
        records: arr(c.records, 100000).map((v) => {
          const r = record(v),
            slug = str(r.slug, 100);
          if (!/^[a-zA-Z0-9_-]+$/.test(slug))
            throw new ValidationError(
              "콘텐츠 주소는 영문, 숫자, 밑줄, 대시를 사용하세요.",
            );
          const fields = record(r.fields);
          if (Object.keys(fields).length > 100)
            throw new ValidationError("콘텐츠 필드는 최대 100개입니다.");
          if (r.status !== "draft" && r.status !== "published")
            throw new ValidationError("콘텐츠 게시 상태를 확인하세요.");
          const publishedAt = str(r.publishedAt, 100);
          if (publishedAt && !Number.isFinite(Date.parse(publishedAt)))
            throw new ValidationError("콘텐츠 게시 시각을 확인하세요.");
          const item: ContentRecord = {
            id: identifier(r.id),
            slug,
            title: str(r.title, 1000),
            body: str(r.body, 50000),
            category: str(r.category, 200),
            imageId: str(r.imageId, 100),
            status: r.status as "draft" | "published",
            publishedAt,
            ...(r.values !== undefined
              ? { values: parseCmsValues(r.values) }
              : {}),
            ...(r.archivedValues !== undefined
              ? { archivedValues: parseCmsValues(r.archivedValues) }
              : {}),
            ...(r.workflow !== undefined
              ? { workflow: parseContentWorkflow(r.workflow) }
              : {}),
            ...(r.contentRevision !== undefined
              ? {
                  contentRevision: num(
                    r.contentRevision,
                    0,
                    0,
                    Number.MAX_SAFE_INTEGER,
                  ),
                }
              : {}),
            ...(r.translations !== undefined
              ? {
                  translations: translated(r.translations, (t) => ({
                    title: str(t.title, 1000),
                    body: str(t.body, 50000),
                    ...(t.values !== undefined
                      ? { values: parseCmsValues(t.values) }
                      : {}),
                  })),
                }
              : {}),
            fields: Object.fromEntries(
              Object.entries(fields).map(([key, v]) => [
                identifier(key),
                str(v, 10000),
              ]),
            ),
          };
          enrichContentState(item, r);
          return item;
        }),
      };
      if (c.schema !== undefined) collection.schema = parseCmsSchema(c.schema);
      if (c.schemaRevision !== undefined)
        collection.schemaRevision = num(
          c.schemaRevision,
          0,
          0,
          Number.MAX_SAFE_INTEGER,
        );
      if (c.queryMode !== undefined) {
        if (c.queryMode !== "snapshot" && c.queryMode !== "server")
          throw new ValidationError("콘텐츠 조회 방식을 확인하세요.");
        collection.queryMode = c.queryMode;
      }
      unique(
        collection.records.map((r) => r.id),
        "콘텐츠 ID",
      );
      unique(
        collection.records.map((r) => r.slug),
        "콘텐츠 주소",
      );
      return collection;
    });
    unique(
      p.collections.map((c) => c.id),
      "컬렉션 ID",
    );
    const routes = p.collections.flatMap((c) =>
      c.records.map((r) => `${c.path === "/" ? "" : c.path}/${r.slug}`),
    );
    unique(
      [
        ...p.pages.flatMap((page) => [page.path, ...(page.aliases ?? [])]),
        ...routes,
      ],
      "콘텐츠 경로",
    );
  }
  if (raw.extensions !== undefined) {
    const e = record(raw.extensions);
    p.extensions = {};
    for (const key of ["favorites", "recentBlocks"] as const)
      if (e[key] !== undefined)
        p.extensions[key] = arr(e[key], 100).map((v) => {
          const item = CATALOG.find((x) => x.type === v);
          if (!item)
            throw new ValidationError("지원하지 않는 즐겨찾기 블록입니다.");
          return item.type;
        });
    if (e.archived !== undefined) p.extensions.archived = bool(e.archived);
    if (e.checklist !== undefined)
      p.extensions.checklist = arr(e.checklist, 100).map((v) => {
        const r = record(v);
        return {
          id: identifier(r.id),
          label: str(r.label, 500),
          checked: bool(r.checked),
        };
      });
    if (e.reusableSections !== undefined)
      p.extensions.reusableSections = arr(e.reusableSections, 100).map((v) => {
        const section = record(v);
        const homeId = p.pages.find((page) => page.home)!.id;
        const sectionProject = parseProject({
          ...p,
          extensions: undefined,
          blocks: arr(section.blocks, 1000).map((v) => ({
            ...record(v),
            pageId: homeId,
          })),
          collections: [],
        });
        return {
          id: identifier(section.id),
          name: str(section.name, 200),
          blocks: sectionProject.blocks,
        };
      });
  }
  const libraryBase = {
    ...p,
    extensions: undefined,
    components: undefined,
    componentHistory: undefined,
    brandPacks: undefined,
    industryPacks: undefined,
    blocks: [],
    collections: [],
  };
  const libraryBlocks = (value: unknown) =>
    parseProject({
      ...libraryBase,
      blocks: arr(value, 1000).map((value) => ({
        ...record(value),
        pageId: p.pages.find((page) => page.home)!.id,
      })),
    }).blocks;
  if (raw.components !== undefined) {
    p.components = arr(raw.components, 100).map((value) => {
      const item = record(value);
      return {
        id: identifier(item.id),
        name: str(item.name, 200),
        version: num(item.version, 1, 1, 100000),
        blocks: libraryBlocks(item.blocks),
      };
    });
    unique(
      p.components.map((item) => item.id),
      "컴포넌트 ID",
    );
  }
  if (raw.componentHistory !== undefined) {
    p.componentHistory = arr(raw.componentHistory, 200).map((value) => {
      const item = record(value);
      return {
        id: identifier(item.id),
        name: str(item.name, 200),
        version: num(item.version, 1, 1, 100000),
        blocks: libraryBlocks(item.blocks),
      };
    });
    unique(
      p.componentHistory.map((item) => `${item.id}@${item.version}`),
      "컴포넌트 기준 버전",
    );
  }
  if (raw.brandPacks !== undefined) {
    p.brandPacks = arr(raw.brandPacks, 100).map((value) => {
      const item = record(value);
      return {
        id: identifier(item.id),
        name: str(item.name, 200),
        version: num(item.version, 1, 1, 100000),
        theme: parseProject({ ...libraryBase, theme: item.theme }).theme,
      };
    });
    unique(
      p.brandPacks.map((item) => item.id),
      "브랜드 ID",
    );
  }
  if (raw.industryPacks !== undefined) {
    p.industryPacks = arr(raw.industryPacks, 100).map((value) => {
      const item = record(value);
      return {
        id: identifier(item.id),
        name: str(item.name, 200),
        version: num(item.version, 1, 1, 100000),
        sections: arr(item.sections, 100).map((value) => {
          const section = record(value);
          return {
            id: identifier(section.id),
            name: str(section.name, 200),
            blocks: libraryBlocks(section.blocks),
          };
        }),
        ...(item.brandPackId
          ? { brandPackId: identifier(item.brandPackId) }
          : {}),
      };
    });
    unique(
      p.industryPacks.map((item) => item.id),
      "업종 팩 ID",
    );
  }
  for (const language of p.settings.languages ?? [])
    if (language !== p.settings.language) {
      const prefix = new RegExp(`^/${language}(?:/|$)`);
      if (
        p.pages.some((page) =>
          [page.path, ...(page.aliases ?? [])].some((path) =>
            prefix.test(path),
          ),
        ) ||
        p.collections?.some((collection) => prefix.test(collection.path))
      )
        throw new ValidationError(
          `/${language} 경로는 추가 언어에 예약되어 있습니다.`,
        );
    }
}

function enhanceBlock(b: Block, value: unknown): void {
  const r = record(value),
    props = record(r.props),
    design = record(r.design),
    layout = record(r.layout);
  if (r.definitionVersion !== undefined)
    b.definitionVersion = num(r.definitionVersion, 1, 1, 100000);
  if (r.componentLink !== undefined) {
    const link = record(r.componentLink);
    b.componentLink = {
      componentId: identifier(link.componentId),
      ...(link.instanceId ? { instanceId: identifier(link.instanceId) } : {}),
      ...(link.sourceBlockId
        ? { sourceBlockId: identifier(link.sourceBlockId) }
        : {}),
      version: num(link.version, 1, 1, 100000),
      overrides: arr(link.overrides, 100).map((value) => str(value, 200)),
    };
  }
  if (props.extensionDefinitionId !== undefined)
    b.props.extensionDefinitionId = str(props.extensionDefinitionId, 220);
  if (props.dataBinding !== undefined) {
    const binding = record(props.dataBinding),
      mapping = record(binding.mapping);
    b.props.dataBinding = {
      connectionId: identifier(binding.connectionId),
      limit: num(binding.limit, 20, 1, 100),
      mapping: Object.fromEntries(
        ["title", "body", "image", "value", "label"]
          .filter((key) => mapping[key] !== undefined)
          .map((key) => [key, identifier(mapping[key])]),
      ),
    };
  }
  if (props.navigationBehavior !== undefined) {
    if (
      props.navigationBehavior !== "section" &&
      props.navigationBehavior !== "scroll"
    )
      throw new ValidationError("메뉴 동작을 확인하세요.");
    b.props.navigationBehavior = props.navigationBehavior;
  }
  if (props.headingLevel !== undefined) {
    if (
      typeof props.headingLevel !== "number" ||
      ![1, 2, 3].includes(props.headingLevel)
    )
      throw new ValidationError("제목 단계는 1~3입니다.");
    b.props.headingLevel = props.headingLevel as 1 | 2 | 3;
  }
  if (props.richText !== undefined)
    b.props.richText = arr(props.richText, 1000).map((v) => {
      const para = record(v);
      if (!["paragraph", "bullet", "ordered"].includes(String(para.kind)))
        throw new ValidationError("지원하지 않는 문단 형식입니다.");
      return {
        kind: para.kind as "paragraph" | "bullet" | "ordered",
        spans: arr(para.spans, 1000).map((v) => {
          const s = record(v),
            href = str(s.href, 2048);
          if (href && !safeUrl(href))
            throw new ValidationError("본문 링크가 올바르지 않습니다.");
          return {
            text: str(s.text, 10000),
            ...(s.bold !== undefined ? { bold: bool(s.bold) } : {}),
            ...(s.italic !== undefined ? { italic: bool(s.italic) } : {}),
            ...(href ? { href } : {}),
          };
        }),
      };
    });
  if (props.imageSettings !== undefined) {
    const s = record(props.imageSettings);
    b.props.imageSettings = {
      decorative: bool(s.decorative),
      fit: s.fit === "contain" ? "contain" : "cover",
      ratio: num(s.ratio, 0, 0, 10),
      focalX: num(s.focalX, 50, 0, 100),
      focalY: num(s.focalY, 50, 0, 100),
    };
  }
  if (props.formSettings !== undefined) {
    const s = record(props.formSettings);
    b.props.formSettings = {
      successMessage: str(s.successMessage),
      successAction: parseAction(s.successAction),
      privacyNotice: str(s.privacyNotice, 10000),
      consentRequired: bool(s.consentRequired),
      category: str(s.category, 200),
    };
  }
  if (props.collectionBinding !== undefined) {
    const s = record(props.collectionBinding);
    const limit = num(s.limit, 20, 1, 1000);
    if (!Number.isInteger(limit))
      throw new ValidationError("콘텐츠 개수는 정수여야 합니다.");
    b.props.collectionBinding = {
      collectionId: identifier(s.collectionId),
      category: str(s.category, 200),
      limit,
      detailLinks: bool(s.detailLinks),
    };
  }
  if (props.chartBinding !== undefined) {
    const s = record(props.chartBinding);
    b.props.chartBinding = {
      tableBlockId: identifier(s.tableBlockId),
      labelColumnId: identifier(s.labelColumnId),
      valueColumnId: identifier(s.valueColumnId),
      unit: str(s.unit, 100),
      xLabel: str(s.xLabel, 200),
      yLabel: str(s.yLabel, 200),
    };
  }
  if (props.chartLabels !== undefined)
    b.props.chartLabels = arr(props.chartLabels, 1000).map((v) => str(v, 200));
  if (props.translations !== undefined)
    b.props.translations = translated(props.translations, (t) => ({
      title: str(t.title, 1000),
      body: str(t.body, 50000),
      primaryAction: str(t.primaryAction, 200),
      secondaryAction: str(t.secondaryAction, 200),
    }));
  arr(props.fields, 100).forEach((v, i) => {
    const s = record(v);
    if (s.description !== undefined)
      b.props.fields[i]!.description = str(s.description);
  });
  arr(props.columns, 100).forEach((v, i) => {
    const s = record(v),
      column = b.props.columns[i]!;
    for (const key of ["required", "unique", "readOnly", "hidden"] as const)
      if (s[key] !== undefined) column[key] = bool(s[key]);
    if (s.width !== undefined) column.width = num(s.width, 160, 40, 2000);
    if (s.order !== undefined) column.order = num(s.order, i, 0, 1000);
  });
  if (layout.responsive !== undefined) {
    const s = record(layout.responsive);
    b.layout.responsive = {
      ...(s.tablet !== undefined ? { tablet: responsive(s.tablet) } : {}),
      ...(s.mobile !== undefined ? { mobile: responsive(s.mobile) } : {}),
    };
  }
  if (design.themeMode !== undefined) {
    if (design.themeMode !== "theme" && design.themeMode !== "custom")
      throw new ValidationError("스타일 상속 설정을 확인하세요.");
    b.design.themeMode = design.themeMode;
  }
  for (const key of ["fontSize", "headingSize", "lineHeight"] as const)
    if (design[key] !== undefined)
      b.design[key] = num(
        design[key],
        16,
        key === "lineHeight" ? 1 : 10,
        key === "lineHeight" ? 3 : 160,
      );
  if (design.animation !== undefined) {
    if (!["none", "fade", "slide"].includes(String(design.animation)))
      throw new ValidationError("지원하지 않는 애니메이션입니다.");
    b.design.animation = design.animation as "none" | "fade" | "slide";
  }
}
