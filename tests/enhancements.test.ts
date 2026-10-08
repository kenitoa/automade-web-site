import test from "node:test";
import assert from "node:assert/strict";
import { createBlock, createProject } from "../src/domain/catalog";
import {
  parseProject,
  inspectProject,
  validateForm,
} from "../src/domain/validation";
import { publicProject, memberProject } from "../src/domain/publication";
import {
  duplicatePage,
  insertSection,
  saveSection,
  moveBlocks,
  deletePage,
} from "../src/domain/commands";
import {
  effectiveDesign,
  findContent,
  getBoundItems,
  getChartData,
  importTableCsv,
  validateTableRows,
  visibleColumns,
} from "../src/domain/content";
import { pageMetadata, sitemap, siteRoutes } from "../src/domain/seo";
import { html } from "../src/runtime/document";
import type { ContentCollection } from "../src/domain/types";
import {
  localizedPath,
  parseLocalizedPath,
  localizeProject,
} from "../src/domain/localization";

const collection = (): ContentCollection => ({
  id: "cases",
  name: "작업 사례",
  path: "/cases",
  records: [
    {
      id: "published-record",
      slug: "first",
      title: "첫 사례",
      body: "실제 작업 설명",
      category: "웹",
      imageId: "",
      status: "published",
      publishedAt: "2026-10-07T00:00:00Z",
      fields: { client: "업체" },
    },
    {
      id: "draft-record",
      slug: "draft",
      title: "DRAFT_SECRET",
      body: "DRAFT_BODY",
      category: "웹",
      imageId: "",
      status: "draft",
      publishedAt: "",
      fields: {},
    },
  ],
});
test("optional enhancements round-trip within schema v2 and old custom design stays compatible", () => {
  const p = createProject("사이트");
  p.settings.brief = {
    purpose: "business",
    audience: "고객",
    primaryGoal: "문의",
    tone: "전문적",
    materials: ["실제 사례"],
  };
  p.settings.siteUrl = "https://example.com";
  p.settings.languages = ["ko", "en"];
  p.theme.typography = {
    bodySize: 18,
    headingSize: 48,
    lineHeight: 1.7,
    sectionGap: 32,
    contentWidth: 1200,
  };
  p.pages[0]!.seo = {
    title: "검색 제목",
    description: "페이지 설명",
    imageAssetId: "",
    noIndex: false,
  };
  p.pages[0]!.aliases = ["/old"];
  p.pages[0]!.translations = { en: { title: "Home", description: "Welcome" } };
  const b = createBlock("text", p, p.pages[0]!.id);
  b.layout.responsive = { mobile: { padding: 12, fontSize: 16, columns: 1 } };
  b.props.richText = [
    {
      kind: "paragraph",
      spans: [{ text: "원문", bold: true, href: "https://example.com" }],
    },
  ];
  p.blocks.push(b);
  p.collections = [collection()];
  assert.deepEqual(parseProject(p), p);
  delete b.design.themeMode;
  p.theme.surfaceColor = "#111111";
  assert.equal(
    effectiveDesign(parseProject(p), parseProject(p).blocks[0]!).background,
    b.design.background,
  );
  b.design.themeMode = "theme";
  assert.equal(effectiveDesign(p, b).background, "#111111");
});
test("unsafe rich links, credentials, hostile aliases and invalid responsive data are rejected", () => {
  const p = createProject(),
    b = createBlock("text", p, p.pages[0]!.id);
  p.blocks.push(b);
  b.props.richText = [
    {
      kind: "paragraph",
      spans: [{ text: "링크", href: "javascript:alert(1)" }],
    },
  ];
  assert.throws(() => parseProject(p));
  delete b.props.richText;
  p.settings.siteUrl = "https://secret:password@example.com";
  assert.throws(() => parseProject(p));
  delete p.settings.siteUrl;
  p.pages[0]!.aliases = ["/api/secret"];
  assert.throws(() => parseProject(p));
  delete p.pages[0]!.aliases;
  b.layout.responsive = { mobile: { fontSize: Infinity } };
  assert.throws(() => parseProject(p));
  assert.throws(() =>
    parseProject({
      ...p,
      blocks: [
        {
          ...b,
          layout: { ...b.layout, responsive: undefined },
          props: { ...b.props, headingLevel: "1" },
        },
      ],
    }),
  );
});
test("CMS lists filter published records and details resolve without leaking draft data", () => {
  const p = createProject(),
    b = createBlock("cards", p, p.pages[0]!.id);
  p.collections = [collection()];
  p.blocks.push(b);
  b.props.collectionBinding = {
    collectionId: "cases",
    category: "웹",
    limit: 1,
    detailLinks: true,
  };
  const items = getBoundItems(p, b);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.detailPath, "/cases/first");
  assert.equal(findContent(p, "/cases/draft"), undefined);
  assert.equal(findContent(p, "/cases/first")?.record.title, "첫 사례");
  const output = html(p, undefined, "/cases/first");
  assert.match(output, /<h1>첫 사례<\/h1>/);
  assert.ok(!output.includes("DRAFT_SECRET"));
  assert.ok(!output.includes("DRAFT_BODY"));
  b.props.collectionBinding.category = "다른 분류";
  assert.equal(getBoundItems(p, b).length, 0);
});
test("member content is absent from HTML and serialization but available to authenticated projection", () => {
  const p = createProject();
  p.pages.push({
    id: "members",
    title: "회원 자료",
    description: "PRIVATE_DESCRIPTION",
    path: "/members",
    published: true,
    home: false,
    access: "members",
    translations: {
      en: { title: "Members", description: "PRIVATE_TRANSLATION" },
    },
  });
  const b = createBlock("text", p, "members");
  b.props.body = "PRIVATE_MEMBER_BODY";
  p.blocks.push(b);
  p.collections = [{ ...collection(), access: "members" }];
  p.settings.brief = {
    purpose: "business",
    audience: "PRIVATE_BRIEF",
    primaryGoal: "",
    tone: "",
    materials: [],
  };
  p.extensions = {
    checklist: [{ id: "private", label: "PRIVATE_CHECKLIST", checked: false }],
  };
  const pub = publicProject(p),
    encoded = JSON.stringify(pub);
  for (const secret of [
    "PRIVATE_DESCRIPTION",
    "PRIVATE_TRANSLATION",
    "PRIVATE_MEMBER_BODY",
    "PRIVATE_BRIEF",
    "PRIVATE_CHECKLIST",
    "DRAFT_SECRET",
    "실제 작업 설명",
  ])
    assert.ok(!encoded.includes(secret), secret);
  assert.equal(memberProject(p).blocks[0]!.props.body, "PRIVATE_MEMBER_BODY");
  assert.equal(memberProject(p).collections![0]!.records.length, 1);
  const output = html(p, "members");
  assert.ok(!output.includes("PRIVATE_MEMBER_BODY"));
  assert.match(output, /회원 전용 페이지/);
  assert.throws(() =>
    parseProject({ ...p, pages: [{ ...p.pages[0], access: "members" }] }),
  );
});
test("SEO excludes drafts, private routes, noindex and protected members from sitemap", () => {
  const p = createProject("이름");
  p.settings.siteUrl = "https://example.com";
  p.collections = [collection()];
  p.pages.push({
    id: "not-indexed",
    title: "숨김",
    path: "/noindex",
    description: "",
    published: true,
    home: false,
    seo: { title: "", description: "", imageAssetId: "", noIndex: true },
  });
  p.pages.push({
    id: "protected",
    title: "회원",
    path: "/members",
    description: "",
    published: true,
    home: false,
    access: "members",
  });
  const xml = sitemap(p);
  assert.match(xml, /https:\/\/example.com\/cases\/first/);
  assert.ok(!xml.includes("draft"));
  assert.ok(!xml.includes("/noindex"));
  assert.ok(!xml.includes("/members"));
  assert.equal(siteRoutes(p).length, 4);
  assert.equal(
    pageMetadata(p, undefined, "/cases/first").canonical,
    "https://example.com/cases/first",
  );
  assert.match(html(p), /rel="canonical" href="https:\/\/example.com\/"/);
});
test("CSV import parses quotes and newlines, maps reordered columns and reports constraints", () => {
  const columns = [
    {
      id: "name",
      label: "이름",
      type: "text" as const,
      required: true,
      unique: true,
    },
    { id: "count", label: "수량", type: "number" as const },
  ];
  const imported = importTableCsv(
    '수량,이름\r\n2,"a,b"\r\n3,"줄\n바꿈"',
    columns,
  );
  assert.deepEqual(
    imported.rows.map((r) => r.values),
    [
      ["a,b", "2"],
      ["줄\n바꿈", "3"],
    ],
  );
  assert.equal(imported.errors.length, 0);
  const invalid = importTableCsv("이름,수량\na,2\na,nope\n,1", columns);
  assert.equal(invalid.errors.length, 3);
  assert.throws(() => importTableCsv('이름,수량\n"a,1', columns));
  assert.throws(() => importTableCsv("X,Y\na,1", columns));
  const duplicate = importTableCsv("이름,수량\na,1", columns, undefined, [
    { id: "existing", values: ["a", "2"] },
  ]);
  assert.equal(duplicate.errors.length, 1);
});
test("table immutable cells, real dates and unique values are validated across full state", () => {
  const columns = [
    {
      id: "date",
      label: "날짜",
      type: "date" as const,
      required: true,
      readOnly: true,
    },
    {
      id: "name",
      label: "이름",
      type: "text" as const,
      unique: true,
      hidden: true,
    },
  ];
  const previous = [{ id: "one", values: ["2026-10-07", "a"] }];
  assert.equal(
    validateTableRows(
      columns,
      [
        { id: "one", values: ["2026-02-30", "a"] },
        { id: "two", values: ["2026-99-01", "a"] },
      ],
      previous,
    ).length,
    4,
  );
  assert.deepEqual(
    visibleColumns(columns).map((x) => x.column.id),
    ["date"],
  );
});
test("chart binding uses typed table values and supports updated operational rows", () => {
  const p = createProject(),
    table = createBlock("table", p, p.pages[0]!.id),
    chart = createBlock("chart", p, p.pages[0]!.id);
  table.props.columns = [
    { id: "label", label: "항목", type: "text" },
    { id: "amount", label: "수량", type: "number" },
  ];
  table.props.rows = [
    { id: "a", values: ["첫째", "2"] },
    { id: "b", values: ["둘째", ""] },
  ];
  chart.props.chartBinding = {
    tableBlockId: table.id,
    labelColumnId: "label",
    valueColumnId: "amount",
    unit: "개",
    xLabel: "항목",
    yLabel: "수량",
  };
  p.blocks.push(table, chart);
  assert.deepEqual(getChartData(p, chart), {
    labels: ["첫째"],
    values: [2],
    unit: "개",
  });
  assert.deepEqual(
    getChartData(p, chart, [{ id: "live", values: ["최신", "5"] }]).values,
    [5],
  );
});
test("page clone remaps internal page, modal, form completion and chart table links", () => {
  const p = createProject(),
    page = p.pages[0]!,
    form = createBlock("form", p, page.id),
    modal = createBlock("modal", p, page.id),
    table = createBlock("table", p, page.id),
    chart = createBlock("chart", p, page.id);
  form.props.secondary = { kind: "navigate", target: page.id };
  form.props.formSettings = {
    successMessage: "감사합니다",
    successAction: { kind: "modal", target: modal.id },
    privacyNotice: "",
    consentRequired: false,
    category: "",
  };
  chart.props.chartBinding = {
    tableBlockId: table.id,
    labelColumnId: "name",
    valueColumnId: "status",
    unit: "",
    xLabel: "",
    yLabel: "",
  };
  p.blocks.push(form, modal, table, chart);
  const copied = duplicatePage(p, page.id),
    copyPage = copied.pages[1]!,
    copiedBlocks = copied.blocks.filter((b) => b.pageId === copyPage.id);
  assert.equal(copyPage.home, false);
  assert.equal(copyPage.path, "/page-copy");
  assert.deepEqual(copiedBlocks[0]!.props.secondary, {
    kind: "navigate",
    target: copyPage.id,
  });
  assert.deepEqual(copiedBlocks[0]!.props.formSettings!.successAction, {
    kind: "modal",
    target: copiedBlocks[1]!.id,
  });
  assert.equal(
    copiedBlocks[3]!.props.chartBinding!.tableBlockId,
    copiedBlocks[2]!.id,
  );
});
test("reusable sections preserve descendants and remain readable after source page deletion", () => {
  const p = createProject(),
    other = { ...p.pages[0]!, id: "other", path: "/other", home: false };
  p.pages.push(other);
  const parent = createBlock("container", p, "other"),
    child = createBlock("text", p, "other");
  child.parentId = parent.id;
  p.blocks.push(parent, child);
  const saved = saveSection(p, [parent.id], "소개 묶음"),
    removed = deletePage(saved, "other"),
    normalized = parseProject(removed);
  const inserted = insertSection(
    normalized,
    normalized.extensions!.reusableSections![0]!.id,
    p.pages[0]!.id,
  );
  assert.equal(inserted.blocks.length, 2);
  assert.equal(inserted.blocks[1]!.parentId, inserted.blocks[0]!.id);
  const moved = moveBlocks(p, [parent.id], p.pages[0]!.id);
  assert.ok(moved.blocks.every((b) => b.pageId === p.pages[0]!.id));
});
test("consent is required server-side and completion rules generate actionable issues", () => {
  const p = createProject(),
    b = createBlock("form", p, p.pages[0]!.id);
  p.blocks.push(b);
  b.props.formSettings = {
    consentRequired: true,
    privacyNotice: "",
    successMessage: "완료",
    successAction: { kind: "none" },
    category: "상담",
  };
  const values = {
    name: "이름",
    email: "user@example.com",
    message: "실제 문의입니다",
  };
  assert.ok(
    validateForm(b.props.fields, values, b.props.formSettings).errors.__consent,
  );
  assert.equal(
    validateForm(
      b.props.fields,
      { ...values, __consent: "true" },
      b.props.formSettings,
    ).values.__consent,
    "true",
  );
  const issue = inspectProject(p).find((i) => i.code === "CONSENT_NOTICE")!;
  assert.equal(issue.field, "props.formSettings");
  assert.ok(issue.impact);
  assert.equal(issue.method, "automatic");
});
test("structured prose escapes markup, preserves semantic emphasis/lists and safe links", () => {
  const p = createProject(),
    b = createBlock("text", p, p.pages[0]!.id);
  p.blocks.push(b);
  b.props.richText = [
    {
      kind: "paragraph",
      spans: [{ text: "<script>alert(1)</script>", bold: true }],
    },
    {
      kind: "bullet",
      spans: [{ text: "내용", italic: true, href: "https://example.com" }],
    },
  ];
  const output = html(p);
  assert.ok(output.includes("&lt;script&gt;"));
  assert.ok(!output.includes("<script>alert(1)</script>"));
  assert.match(output, /<ul><li>/);
  assert.match(output, /<strong>/);
  assert.match(output, /<em>/);
});
test("language URLs preserve base paths and SSR matches translated canonical and hreflang", () => {
  const p = createProject("Primary site");
  p.settings.siteUrl = "https://example.org";
  p.settings.languages = ["en"];
  p.pages[0]!.translations = {
    en: { title: "English home", description: "English description" },
  };
  p.collections = [collection()];
  p.collections[0]!.records[0]!.translations = {
    en: { title: "English case", body: "Translated case body" },
  };
  assert.equal(localizedPath(p, "/cases/first", "ko"), "/cases/first");
  assert.equal(localizedPath(p, "/cases/first", "en"), "/en/cases/first");
  assert.deepEqual(parseLocalizedPath(p, "/en/cases/first/"), {
    path: "/cases/first",
    language: "en",
  });
  assert.equal(
    siteRoutes(p).filter((route) => route.language === "en").length,
    2,
  );
  const output = html(p, undefined, "/cases/first", "en");
  assert.match(output, /<html lang="en">/);
  assert.match(output, /<h1>English case<\/h1>/);
  assert.match(output, /Translated case body/);
  assert.match(
    output,
    /rel="canonical" href="https:\/\/example.org\/en\/cases\/first"/,
  );
  assert.match(
    output,
    /hreflang="ko" href="https:\/\/example.org\/cases\/first"/,
  );
  assert.match(
    output,
    /hreflang="en" href="https:\/\/example.org\/en\/cases\/first"/,
  );
  assert.match(
    output,
    /hreflang="x-default" href="https:\/\/example.org\/cases\/first"/,
  );
  assert.match(sitemap(p), /https:\/\/example.org\/en\/cases\/first/);
  assert.equal(
    pageMetadata(p, undefined, undefined, "en").title,
    "English home",
  );
  assert.deepEqual(
    parseProject(p).collections![0]!.records[0]!.translations,
    p.collections[0]!.records[0]!.translations,
  );
  p.pages[0]!.aliases = ["/en/collision"];
  assert.throws(() => parseProject(p));
});
test("protected CMS detail routes emit only safe login shells in every language", () => {
  const p = createProject();
  p.settings.siteUrl = "https://example.org";
  p.settings.languages = ["ko", "en"];
  p.collections = [
    { ...collection(), path: "/private-cases", access: "members" },
  ];
  p.collections[0]!.records[0]!.title = "MEMBER_SECRET_TITLE";
  p.collections[0]!.records[0]!.body = "MEMBER_SECRET_BODY";
  p.collections[0]!.records[0]!.translations = {
    en: {
      title: "MEMBER_SECRET_TRANSLATION",
      body: "MEMBER_SECRET_TRANSLATED_BODY",
    },
  };
  const routes = siteRoutes(p).filter((route) => route.contentPath);
  assert.deepEqual(
    routes.map((route) => [route.path, route.noIndex]),
    [
      ["/private-cases/first", true],
      ["/en/private-cases/first", true],
    ],
  );
  for (const route of routes) {
    const output = html(p, route.pageId, route.contentPath, route.language);
    assert.ok(!output.includes("MEMBER_SECRET"));
    assert.match(output, /회원 전용 페이지/);
    assert.ok(output.includes(`href="https://example.org${route.path}"`));
    assert.match(output, /name="robots" content="noindex,follow"/);
  }
  assert.ok(!sitemap(p).includes("private-cases"));
  assert.equal(
    localizeProject(memberProject(p), "en").collections![0]!.records[0]!.title,
    "MEMBER_SECRET_TRANSLATION",
  );
});
