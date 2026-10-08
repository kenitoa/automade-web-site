import test from "node:test";
import assert from "node:assert/strict";
import { createBlock, createProject } from "../src/domain/catalog";
import { getBlockDefinition } from "../src/domain/blockRegistry";
import { parseProject } from "../src/domain/validation";
import {
  packageIntegrity,
  parseDeclarativePackage,
  preflightProject,
  createPackageBlock,
  verifyPackageIntegrity,
  previewPackageUpdate,
  removePackage,
  blockEnvironmentIssues,
} from "../src/domain/packages";
import { publicProject } from "../src/domain/publication";
import {
  queryCollection,
  transitionContent,
  editContentRecord,
  validateCmsRecord,
  previewSchemaChange,
  withCmsSnapshot,
} from "../src/domain/cms";
import {
  instantiateComponent,
  previewComponentUpdate,
  setComponentOverride,
  previewBrandUpdate,
  previewIndustryPack,
} from "../src/domain/shared";
import { localizeProject } from "../src/domain/localization";
import { html } from "../src/runtime/document";
import type { ContentCollection } from "../src/domain/types";
import { checkExtension } from "../scripts/check-extension";
import {
  minimizeScopedProposal,
  mergeScopedProposal,
} from "../src/domain/scopedProposals";
import { pageMetadata, siteRoutes } from "../src/domain/seo";
import { assetSource } from "../src/domain/assets";
import {
  parseWaitlistEntries,
  visibleWaitlistState,
} from "../src/domain/waitlist";
import { effectiveDesign } from "../src/domain/content";
import {
  sitemap,
  sitemapPage,
  sitemapPageCount,
  sitemapArtifacts,
  SITEMAP_PAGE_SIZE,
} from "../src/domain/sitemaps";

test("registered approved timeline preserves schema2 and renders a semantic shared-runtime block", () => {
  const p = createProject(),
    b = createBlock("automade:timeline", p, p.pages[0]!.id);
  p.blocks.push(b);
  assert.equal(getBlockDefinition(b.type)!.propertyProfile, "items");
  assert.equal(parseProject(p).schemaVersion, 2);
  const output = html(p);
  assert.match(output, /<ol class="site-timeline">/);
  assert.match(output, /첫 번째 단계/);
  assert.equal(b.definitionVersion, 1);
});
test("unsupported versions preflight without mutating source; packages reject code and verify actual digest", async () => {
  const p = createProject(),
    b = createBlock("text", p, p.pages[0]!.id);
  p.blocks.push(b);
  const raw = {
      ...p,
      blocks: [
        { ...b, type: "unknown:module", props: { secret: "PRESERVED" } },
      ],
    },
    before = JSON.stringify(raw);
  assert.equal(preflightProject(raw).supported, false);
  assert.equal(JSON.stringify(raw), before);
  assert.throws(() => parseProject(raw), /보존/);
  const source = {
    id: "example.pack",
    name: "Test pack",
    version: "1.0.0",
    protocol: 1,
    definitions: [
      {
        id: "intro",
        name: "Introduction",
        description: "Safe prose",
        template: "text",
        defaults: { title: "Package introduction" },
      },
    ],
  };
  const pack = parseDeclarativePackage({
    ...source,
    integrity: await packageIntegrity(source),
  });
  await verifyPackageIntegrity(pack);
  assert.throws(
    () => parseDeclarativePackage({ ...pack, execute: "alert(1)" }),
    /실행 코드/,
  );
  await assert.rejects(
    () => verifyPackageIntegrity({ ...pack, name: "tampered" }),
    /무결성/,
  );
  p.blockPackages = [pack];
  p.featurePins = [
    { packageId: pack.id, version: pack.version, integrity: pack.integrity },
  ];
  p.blocks.push(createPackageBlock(p, pack.id, "intro", p.pages[0]!.id));
  assert.equal(preflightProject(p).supported, true);
  assert.match(html(parseProject(p)), /Package introduction/);
  p.featurePins[0]!.version = "2.0.0";
  assert.equal(preflightProject(p).supported, false);
});
const typedCollection = (): ContentCollection => ({
  id: "typed",
  name: "Products",
  path: "/products",
  queryMode: "server",
  schema: [
    {
      id: "price",
      label: "Price",
      type: "number",
      required: true,
      public: true,
      min: 0,
    },
    { id: "internal", label: "Internal note", type: "text", public: false },
  ],
  records: Array.from({ length: 35 }, (_, index) => ({
    id: `record-${String(index).padStart(3, "0")}`,
    slug: `product-${index}`,
    title: `Product ${String(index).padStart(3, "0")}`,
    body: "Public",
    category: "",
    imageId: "",
    status: "published",
    publishedAt: "",
    fields: { legacy: "LEGACY_KEPT" },
    values: { price: index, internal: "PRIVATE_TYPED_VALUE" },
  })),
});
test("typed CMS preserves legacy fields, protects custom private fields and queries beyond public snapshots", () => {
  const p = createProject();
  p.collections = [typedCollection()];
  const parsed = parseProject(p);
  assert.equal(
    parsed.collections![0]!.records[0]!.fields.legacy,
    "LEGACY_KEPT",
  );
  assert.equal(publicProject(parsed).collections![0]!.records.length, 20);
  assert.ok(
    !JSON.stringify(publicProject(parsed)).includes("PRIVATE_TYPED_VALUE"),
  );
  const first = queryCollection(
      parsed,
      "typed",
      { limit: 20 },
      { member: false },
    ),
    second = queryCollection(
      parsed,
      "typed",
      { limit: 20, cursor: first.nextCursor },
      { member: false },
    );
  assert.equal(first.records.length, 20);
  assert.equal(second.records.length, 15);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([...first.records, ...second.records].map((record) => record.id))
      .size,
    35,
  );
  assert.throws(
    () =>
      queryCollection(parsed, "typed", { sort: "internal" }, { member: false }),
    /공개 필드/,
  );
  const bad = {
    ...parsed.collections![0]!.records[0]!,
    values: { price: "wrong" },
  };
  assert.ok(
    validateCmsRecord(parsed, parsed.collections![0]!, bad).some((message) =>
      message.includes("숫자"),
    ),
  );
  assert.match(
    html(parsed, undefined, "/products/product-34"),
    /<h1>Product 034<\/h1>/,
  );
});
test("content review binds approval to revision and scheduled visibility uses server time", () => {
  const p = createProject(),
    collection = typedCollection();
  p.collections = [collection];
  let content = {
    ...collection.records[0]!,
    status: "draft" as const,
    contentRevision: 1,
  };
  const reviewed = transitionContent(content, "review"),
    approved = transitionContent(reviewed, "approved"),
    scheduled = transitionContent(
      approved,
      "scheduled",
      "2026-12-01T10:00:00Z",
    );
  collection.records = [scheduled];
  assert.equal(
    queryCollection(
      p,
      collection.id,
      {},
      { member: false, now: "2026-12-01T09:59:59Z" },
    ).records.length,
    0,
  );
  assert.equal(
    queryCollection(
      p,
      collection.id,
      {},
      { member: false, now: "2026-12-01T10:00:00Z" },
    ).records.length,
    1,
  );
  content = editContentRecord(approved, { body: "Edited" }) as typeof content;
  assert.equal(content.contentRevision, 2);
  assert.throws(() => transitionContent(content, "published"), /승인/);
});
test("canonical BCP47 locales and fallback translations keep base routes intact", () => {
  const p = createProject();
  p.settings.languages = ["ja", "fr-ca"];
  p.settings.languageFallbacks = { "fr-CA": "fr" };
  p.pages[0]!.translations = {
    fr: { title: "Accueil", description: "Bonjour" },
    ja: { title: "Home Japanese", description: "Japanese" },
  };
  const parsed = parseProject(p);
  assert.deepEqual(parsed.settings.languages, ["ja", "fr-CA"]);
  assert.equal(localizeProject(parsed, "fr-CA").pages[0]!.title, "Accueil");
  assert.match(html(parsed, undefined, undefined, "ja"), /<html lang="ja">/);
  assert.throws(
    () =>
      parseProject({
        ...p,
        settings: { ...p.settings, language: "../../secret" },
      }),
    /BCP/,
  );
});
test("shared component instances remap trees and selectively update while keeping overrides and IDs", () => {
  let p = createProject();
  const root = createBlock("container", p, p.pages[0]!.id),
    child = createBlock("text", p, p.pages[0]!.id);
  child.parentId = root.id;
  p.blocks.push(root, child);
  const component = {
    id: "shared",
    name: "Shared",
    version: 1,
    blocks: [root, child],
  };
  p = instantiateComponent(p, component, p.pages[0]!.id);
  assert.equal(p.blocks.length, 4);
  assert.equal(p.blocks[3]!.parentId, p.blocks[2]!.id);
  const instanceId = p.blocks[3]!.id;
  p = setComponentOverride(p, instanceId, "props.title", true);
  const updated = {
    ...component,
    version: 2,
    blocks: [
      root,
      {
        ...child,
        props: { ...child.props, title: "Update", body: "New body" },
      },
    ],
  };
  const preview = previewComponentUpdate(p, updated, [instanceId]);
  assert.equal(preview.project.blocks[3]!.id, instanceId);
  assert.equal(preview.project.blocks[3]!.props.title, child.props.title);
  assert.equal(preview.project.blocks[3]!.props.body, "New body");
  assert.equal(p.blocks[3]!.props.body, "");
  const branded = previewBrandUpdate(p, {
    id: "brand",
    name: "Brand",
    version: 2,
    theme: { ...p.theme, surfaceColor: "#eeeeee" },
  });
  assert.equal(branded.project.theme.surfaceColor, "#eeeeee");
  p.blocks[3]!.locked = true;
  p.blocks[3]!.design.themeMode = "theme";
  const guarded = previewBrandUpdate(p, {
    id: "brand",
    name: "Brand",
    version: 3,
    theme: { ...p.theme, surfaceColor: "#bbbbbb" },
  });
  assert.equal(
    effectiveDesign(guarded.project, guarded.project.blocks[3]!).background,
    p.theme.surfaceColor,
  );
  assert.ok(guarded.skippedIds.includes(instanceId));
});

test("schema removals archive values, restore safely and read-only deletion is rejected", () => {
  const p = createProject(),
    collection = typedCollection();
  p.collections = [collection];
  collection.schema![0]!.readOnly = true;
  const original = collection.records[0]!;
  assert.ok(
    validateCmsRecord(
      p,
      collection,
      { ...original, values: {} },
      original,
    ).some((message) => message.includes("읽기 전용")),
  );
  const removed = previewSchemaChange(
    p,
    collection.id,
    collection.schema!.slice(1),
  );
  assert.equal(
    removed.project.collections![0]!.records[0]!.archivedValues?.price,
    original.values?.price,
  );
  assert.equal(removed.errors.length, 0);
  assert.ok(
    !JSON.stringify(publicProject(removed.project)).includes("archivedValues"),
  );
  const restored = previewSchemaChange(
    removed.project,
    collection.id,
    collection.schema,
  );
  assert.equal(
    restored.project.collections![0]!.records[0]!.values?.price,
    original.values?.price,
  );
  assert.equal(collection.records[0]!.archivedValues, undefined);
  const snapshot = withCmsSnapshot(p, {
    revision: 10,
    collections: restored.project.collections,
  });
  assert.equal(snapshot.revision, p.revision);
  assert.throws(() => withCmsSnapshot(p, { revision: -1, collections: [] }));
});

test("localized typed values, detail query and metadata fallback protect private translations", () => {
  const p = createProject(),
    collection = typedCollection();
  p.collections = [collection];
  p.settings.languages = ["fr-CA"];
  p.settings.languageFallbacks = { "fr-CA": "fr" };
  p.pages[0]!.translations = {
    fr: { title: "Accueil", description: "Bonjour" },
  };
  collection.schema![0]!.localized = true;
  collection.schema![1]!.localized = true;
  collection.records[34]!.translations = {
    fr: {
      title: "Produit",
      body: "Corps",
      values: { price: 99, internal: "PRIVATE_TRANSLATED" },
    },
  };
  const parsed = parseProject(p),
    result = queryCollection(
      parsed,
      collection.id,
      { slug: "product-34", language: "fr-ca" },
      { member: false },
    );
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]!.title, "Produit");
  assert.equal(result.records[0]!.values?.price, 99);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_TRANSLATED"));
  assert.equal(
    pageMetadata(parsed, p.pages[0]!.id, undefined, "fr-CA").title,
    "Accueil",
  );
  assert.equal(
    siteRoutes(parsed).filter((route) => route.contentPath).length,
    40,
  );
  assert.equal(result.nextCursor, null);
});

test("public references never expose draft or member record identifiers", () => {
  const p = createProject(),
    collection = typedCollection();
  p.collections = [collection];
  const target: ContentCollection = {
    ...typedCollection(),
    id: "target",
    path: "/target",
    records: [
      {
        ...collection.records[0]!,
        id: "secret-record",
        slug: "secret",
        status: "draft" as const,
      },
    ],
  };
  p.collections.push(target);
  collection.schema!.push({
    id: "relation",
    label: "Relation",
    type: "reference",
    public: true,
    referenceCollectionId: target.id,
  });
  collection.records[0]!.values!.relation = ["secret-record"];
  assert.deepEqual(
    queryCollection(
      p,
      collection.id,
      { slug: collection.records[0]!.slug },
      { member: false },
    ).records[0]!.values!.relation,
    [],
  );
  target.access = "members";
  target.records[0]!.status = "published";
  assert.deepEqual(
    queryCollection(
      p,
      collection.id,
      { slug: collection.records[0]!.slug },
      { member: false },
    ).records[0]!.values!.relation,
    [],
  );
});

test("missing shared sources skip updates and item actions survive content changes", () => {
  let p = createProject();
  const source = createBlock("cards", p, p.pages[0]!.id);
  const component = {
    id: "cards",
    name: "Cards",
    version: 1,
    blocks: [source],
  };
  p = instantiateComponent(p, component, p.pages[0]!.id);
  const instance = p.blocks[0]!;
  instance.props.items[0]!.action = {
    kind: "link",
    url: "https://example.org",
    newTab: true,
  };
  const originalItemId = instance.props.items[0]!.id;
  const updated = structuredClone(component);
  updated.version = 2;
  updated.blocks[0]!.props.items[0]!.title = "New copy";
  const preview = previewComponentUpdate(p, updated);
  assert.equal(preview.project.blocks[0]!.props.items[0]!.id, originalItemId);
  assert.deepEqual(
    preview.project.blocks[0]!.props.items[0]!.action,
    instance.props.items[0]!.action,
  );
  updated.blocks[0]!.id = "replacement-source";
  const missing = previewComponentUpdate(p, updated);
  assert.deepEqual(missing.skippedIds, [instance.id]);
  assert.equal(
    missing.project.blocks[0]!.props.items[0]!.title,
    instance.props.items[0]!.title,
  );
  const pack = {
    id: "industry",
    name: "Industry",
    version: 1,
    sections: [{ id: "section", name: "Cards", blocks: [source] }],
  };
  const inserted = previewIndustryPack(p, pack, p.pages[0]!.id, ["section"]);
  assert.equal(inserted.affectedIds.length, 1);
  assert.notEqual(inserted.affectedIds[0], source.id);
  assert.equal(inserted.project.blocks[0]!.id, instance.id);
});

test("package preview preserves overrides and removal detaches IDs; CLI verifies hashes and environments", async () => {
  const p = createProject(),
    raw = {
      id: "test.copy",
      name: "Copy",
      protocol: 1,
      version: "1.0.0",
      definitions: [
        {
          id: "intro",
          name: "Intro",
          description: "",
          template: "text",
          defaults: { title: "Before", body: "PRIVATE_DEFAULT" },
        },
      ],
    };
  const pack = parseDeclarativePackage({
    ...raw,
    integrity: await packageIntegrity(raw),
  });
  p.blockPackages = [pack];
  p.featurePins = [
    { packageId: pack.id, version: pack.version, integrity: pack.integrity },
  ];
  const block = createPackageBlock(p, pack.id, "intro", p.pages[0]!.id);
  block.props.body = "CUSTOM";
  p.blocks.push(block);
  const changed = {
    ...raw,
    version: "1.1.0",
    definitions: [
      { ...raw.definitions[0]!, defaults: { title: "After", body: "Changed" } },
    ],
  };
  const nextPack = parseDeclarativePackage({
      ...changed,
      integrity: await packageIntegrity(changed),
    }),
    preview = previewPackageUpdate(p, nextPack);
  assert.equal(preview.project.blocks[0]!.props.title, "After");
  assert.equal(preview.project.blocks[0]!.props.body, "CUSTOM");
  assert.ok(!JSON.stringify(publicProject(p)).includes("PRIVATE_DEFAULT"));
  const detached = removePackage(preview.project, pack.id, true);
  assert.equal(detached.blocks[0]!.id, block.id);
  assert.equal(detached.blocks[0]!.type, "text");
  assert.equal((await checkExtension(pack)).supported, true);
  await assert.rejects(() => checkExtension({ ...pack, name: "Tampered" }));
  await assert.rejects(() => checkExtension({ ...pack, code: "evil()" }));
  p.blocks[0]!.props.dataBinding = {
    connectionId: "connection",
    limit: 10,
    mapping: { title: "name" },
  };
  assert.ok(
    blockEnvironmentIssues(p, "static").some((message) =>
      message.includes("서버 조회"),
    ),
  );
  p.blocks[0]!.hidden = true;
  assert.equal(blockEnvironmentIssues(p, "static").length, 0);
  assert.equal(
    (await checkExtension(p, { project: true, target: "node" })).supported,
    true,
  );
});

test("scoped AI CMS edits and translations cannot change denied fields or publishing rules", () => {
  const p = createProject(),
    collection = typedCollection();
  p.collections = [collection];
  const selected = collection.records[0]!;
  selected.translations = {
    en: { title: "Existing", body: "DENIED_TRANSLATION_BODY" },
  };
  const scope = {
      kind: "cms" as const,
      targetId: selected.id,
      allowedFieldIds: ["title" as const],
    },
    minimized = minimizeScopedProposal(p, scope);
  assert.ok(!JSON.stringify(minimized).includes("DENIED_TRANSLATION_BODY"));
  assert.ok(!JSON.stringify(minimized).includes("PRIVATE_TYPED_VALUE"));
  minimized.collections![0]!.records[0]!.translations = {
    en: { title: "Changed", body: "ATTACK" },
  };
  const merged = mergeScopedProposal(p, minimized, "translate", scope),
    output = merged.collections![0]!.records[0]!;
  assert.equal(output.translations!.en!.title, "Changed");
  assert.equal(output.translations!.en!.body, "DENIED_TRANSLATION_BODY");
  assert.deepEqual(output.values, selected.values);
  assert.equal(output.status, "draft");
});

test("blob references keep original lightweight and preview URLs include source ACL scope", () => {
  const p = createProject();
  p.assets.push({
    id: "ref",
    name: "Image",
    alt: "Image",
    mime: "image/png",
    data: "",
    blobRef: { id: "blob", projectId: p.id, sha256: "a".repeat(64) },
  });
  const parsed = parseProject(p);
  assert.equal(parsed.assets[0]!.data, "");
  assert.match(
    assetSource(parsed.assets[0], "/", "preview"),
    new RegExp(`projectId=${p.id}`),
  );
  assert.equal(
    assetSource(parsed.assets[0], "/", "site"),
    "/assets/share-ref.png",
  );
  assert.throws(() =>
    parseProject({
      ...p,
      assets: [
        { ...p.assets[0], blobRef: { ...p.assets[0]!.blobRef, sha256: "bad" } },
      ],
    }),
  );
});

test("full public CMS sitemap excludes drafts and member URLs and shards all locales beyond snapshot limits", () => {
  const p = createProject(),
    collection = typedCollection();
  p.settings.siteUrl = "https://example.org";
  p.settings.languages = ["fr-CA"];
  p.collections = [collection];
  p.pages.push({
    id: "noindex",
    title: "Excluded",
    path: "/excluded",
    description: "",
    home: false,
    published: true,
    seo: { title: "", description: "", imageAssetId: "", noIndex: true },
  });
  p.pages.push({
    id: "private",
    title: "Members",
    path: "/members",
    description: "",
    home: false,
    published: true,
    access: "members",
  });
  p.collections.push({
    ...collection,
    id: "private",
    access: "members",
    path: "/member-cms",
  });
  collection.records.push({
    ...collection.records[0]!,
    id: "draft",
    slug: "private-draft",
    status: "draft",
  });
  const output = sitemap(p);
  assert.match(output, /example\.org\/products\/product-34/);
  assert.match(output, /example\.org\/fr-CA\/products\/product-34/);
  assert.ok(!output.includes("private-draft"));
  assert.ok(!output.includes("/member-cms"));
  assert.ok(!output.includes("/members"));
  assert.ok(!output.includes("/excluded"));
  assert.ok(!output.includes("PRIVATE_TYPED_VALUE"));
  assert.equal((output.match(/<url>/g) ?? []).length, 72);
  collection.records = Array.from({ length: 5001 }, (_, index) => ({
    ...collection.records[0]!,
    id: `item-${index}`,
    slug: `item-${index}`,
  }));
  const parts = [...sitemapArtifacts(p)];
  assert.equal(sitemapPageCount(p), 2);
  assert.equal(parts.length, 3);
  assert.match(parts[0]!.content, /<sitemapindex/);
  assert.match(parts[0]!.content, /https:\/\/example.org\/sitemaps\/2.xml/);
  const urls = parts
    .slice(1)
    .flatMap((part) =>
      [...part.content.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]),
    );
  assert.equal(urls.length, 10004);
  assert.equal(new Set(urls).size, 10004);
  assert.equal(
    (sitemapPage(p, 1).match(/<url>/g) ?? []).length,
    SITEMAP_PAGE_SIZE,
  );
  assert.equal((sitemapPage(p, 2).match(/<url>/g) ?? []).length, 4);
  assert.throws(() => sitemapPage(p, 0), RangeError);
  assert.throws(() => sitemapPage(p, 3), RangeError);
});

test("visitor waitlist rejects malformed server rows and treats elapsed offered holds as expired", () => {
  const entry = {
    id: "wait",
    slotId: "slot",
    accountId: "visitor",
    quantity: 1,
    status: "offered",
    offerExpiresAt: 2000,
    bookingId: null,
    createdAt: "2026-10-07T00:00:00Z",
  };
  const parsed = parseWaitlistEntries([entry]);
  assert.equal(visibleWaitlistState(parsed[0]!, 1999), "offered");
  assert.equal(visibleWaitlistState(parsed[0]!, 2000), "expired");
  assert.throws(() => parseWaitlistEntries([{ ...entry, quantity: 0 }]));
  assert.throws(() =>
    parseWaitlistEntries([{ ...entry, status: "confirmed" }]),
  );
  assert.throws(() =>
    parseWaitlistEntries([{ ...entry, offerExpiresAt: null }]),
  );
  assert.throws(() =>
    parseWaitlistEntries([{ ...entry, createdAt: "invalid" }]),
  );
  assert.throws(() => parseWaitlistEntries({ rows: [entry] }));
  assert.equal(
    visibleWaitlistState(
      parseWaitlistEntries([
        { ...entry, status: "accepted", bookingId: "booking" },
      ])[0]!,
      3000,
    ),
    "accepted",
  );
});
