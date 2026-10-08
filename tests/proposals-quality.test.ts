import test from "node:test";
import assert from "node:assert/strict";
import { createBlock, createProject } from "../src/domain/catalog";
import {
  minimizeProposalProject,
  mergeProposal,
} from "../src/domain/proposals";
import { previewQualityFix } from "../src/domain/quality";
import { inspectProject, parseProject } from "../src/domain/validation";
const fixture = () => {
  const p = createProject("실제 업체"),
    target = createBlock("text", p, p.pages[0]!.id),
    unrelated = createBlock("form", p, p.pages[0]!.id);
  target.props.title = "선택한 제목";
  target.props.body = "선택한 실제 설명";
  target.props.richText = [
    {
      kind: "paragraph",
      spans: [{ text: "참고 링크", href: "https://example.org/original" }],
    },
  ];
  unrelated.props.formSettings = {
    successMessage: "PRIVATE_SUCCESS",
    successAction: { kind: "none" },
    privacyNotice: "PRIVATE_NOTICE",
    consentRequired: true,
    category: "PRIVATE_CATEGORY",
  };
  unrelated.props.secondary = {
    kind: "link",
    url: "https://example.org/PRIVATE_URL",
    newTab: false,
  };
  unrelated.props.translations = {
    en: {
      title: "PRIVATE_TRANSLATION",
      body: "PRIVATE_BODY",
      primaryAction: "",
      secondaryAction: "",
    },
  };
  p.settings.brief = {
    purpose: "business",
    audience: "PRIVATE_BRIEF",
    primaryGoal: "",
    tone: "",
    materials: [],
  };
  p.settings.customLanguageText = '{"secret":"PRIVATE_SYSTEM_TEXT"}';
  p.settings.siteUrl = "https://example.org";
  p.extensions = {
    checklist: [{ id: "a", label: "PRIVATE_NOTE", checked: false }],
  };
  p.blocks.push(target, unrelated);
  return { p, target, unrelated };
};
test("selected proposal projection strips unrelated text, actions, business rules and all private notes", () => {
  const { p, target } = fixture(),
    payload = minimizeProposalProject(p, target.id),
    json = JSON.stringify(payload);
  assert.match(json, /선택한 실제 설명/);
  for (const secret of [
    "PRIVATE_SUCCESS",
    "PRIVATE_NOTICE",
    "PRIVATE_CATEGORY",
    "PRIVATE_URL",
    "PRIVATE_TRANSLATION",
    "PRIVATE_BODY",
    "PRIVATE_BRIEF",
    "PRIVATE_SYSTEM_TEXT",
    "PRIVATE_NOTE",
    "https://example.org/original",
  ])
    assert.ok(!json.includes(secret), secret);
  assert.equal(
    p.blocks[1]!.props.formSettings!.privacyNotice,
    "PRIVATE_NOTICE",
  );
  assert.throws(() => minimizeProposalProject(p, "missing"));
});
test("copy proposal updates selected prose while preserving contracts, locks, prices and unrelated state", () => {
  const { p, target, unrelated } = fixture(),
    proposal = structuredClone(p);
  const changed = proposal.blocks[0]!;
  changed.props.title = "새 제목";
  changed.hidden = true;
  changed.locked = true;
  changed.design.background = "#000000";
  changed.props.action = {
    kind: "link",
    url: "https://evil.example.org",
    newTab: false,
  };
  proposal.pages[0]!.published = false;
  proposal.pages[0]!.navigation = false;
  proposal.blocks[1]!.props.fields[0]!.required = false;
  proposal.settings.siteUrl = "https://changed.example.org";
  const merged = mergeProposal(p, proposal, "copy", target.id);
  assert.equal(merged.blocks[0]!.props.title, "새 제목");
  assert.deepEqual(merged.blocks[0]!.props.action, target.props.action);
  assert.equal(merged.blocks[0]!.hidden, target.hidden);
  assert.equal(merged.blocks[0]!.locked, false);
  assert.equal(merged.blocks[0]!.design.background, target.design.background);
  assert.deepEqual(merged.blocks[1], unrelated);
  assert.deepEqual(merged.pages, p.pages);
  assert.equal(merged.settings.siteUrl, p.settings.siteUrl);
  assert.equal(merged.revision, p.revision + 1);
});
test("whole-site proposals cannot change data, published permissions or form business rules", () => {
  const { p } = fixture(),
    proposed = structuredClone(p);
  proposed.blocks[1]!.props.fields[0]!.required = false;
  proposed.blocks[1]!.props.formSettings!.consentRequired = false;
  proposed.blocks[1]!.props.formSettings!.privacyNotice = "changed";
  proposed.pages[0]!.published = false;
  proposed.blocks[0]!.props.title = "문구 개선";
  proposed.settings.description = "실제 설명 개선";
  const merged = mergeProposal(p, proposed, "tone");
  assert.equal(merged.blocks[0]!.props.title, "문구 개선");
  assert.equal(merged.settings.description, "실제 설명 개선");
  assert.equal(merged.blocks[1]!.props.formSettings!.consentRequired, true);
  assert.equal(
    merged.blocks[1]!.props.formSettings!.privacyNotice,
    "PRIVATE_NOTICE",
  );
  assert.equal(merged.blocks[1]!.props.fields[0]!.required, true);
  assert.equal(merged.pages[0]!.published, true);
});
test("proposal topology, missing and locked targets are rejected; mobile ignores broader edits", () => {
  const { p, target } = fixture(),
    proposed = structuredClone(p);
  proposed.blocks[0]!.layout.responsive = { mobile: { padding: 12 } };
  proposed.blocks[0]!.props.title = "unauthorized";
  proposed.blocks[0]!.layout.desktopHidden = true;
  const merged = mergeProposal(p, proposed, "mobile", target.id);
  assert.equal(merged.blocks[0]!.props.title, target.props.title);
  assert.equal(merged.blocks[0]!.layout.desktopHidden, false);
  assert.equal(merged.blocks[0]!.layout.responsive!.mobile!.padding, 12);
  assert.throws(() => mergeProposal(p, proposed, "copy", "missing"));
  target.locked = true;
  assert.throws(() => mergeProposal(p, proposed, "copy", target.id));
  target.locked = false;
  proposed.blocks[0]!.pageId = "other";
  assert.throws(() => mergeProposal(p, proposed, "copy", target.id));
});
test("quality preview fixes measured contrast and overflow without mutating source or inventing alt", () => {
  const p = createProject(),
    b = createBlock("text", p, p.pages[0]!.id);
  b.design.color = "#ffffff";
  b.design.themeMode = "custom";
  b.design.background = "#ffffff";
  p.blocks.push(b);
  const issue = inspectProject(p).find((i) => i.code === "CONTRAST")!,
    preview = previewQualityFix(p, issue)!;
  assert.equal(b.design.color, "#ffffff");
  assert.equal(preview.project.blocks[0]!.design.color, "#000000");
  assert.ok(
    !inspectProject(preview.project).some((i) => i.code === "CONTRAST"),
  );
  assert.equal(preview.changes[0]!.field, "design.color");
  b.layout.mode = "absolute";
  b.layout.width = 300;
  b.layout.x = p.canvas.width - 100;
  const overflow = previewQualityFix(
    p,
    inspectProject(p).find((i) => i.code === "OVERFLOW")!,
  )!;
  assert.equal(
    overflow.project.blocks[0]!.layout.x +
      overflow.project.blocks[0]!.layout.width,
    p.canvas.width,
  );
  assert.equal(
    previewQualityFix(p, {
      severity: "warning",
      code: "IMAGE_ALT",
      message: "대체 텍스트",
      blockId: b.id,
    }),
    null,
  );
  b.locked = true;
  assert.equal(previewQualityFix(p, issue), null);
});
test("contrast detection and correction account for transparent parent backgrounds and text", () => {
  const p = createProject(),
    parent = createBlock("container", p, p.pages[0]!.id),
    child = createBlock("text", p, p.pages[0]!.id);
  p.canvas.background = "#ffffff";
  parent.design.themeMode = "custom";
  parent.design.background = "#ffffff00";
  child.parentId = parent.id;
  child.design.themeMode = "custom";
  child.design.background = "#00000000";
  child.design.color = "#ffffff";
  p.blocks.push(parent, child);
  const issue = inspectProject(p).find(
    (value) => value.blockId === child.id && value.code === "CONTRAST",
  )!;
  assert.ok(issue);
  const corrected = previewQualityFix(p, issue)!;
  assert.equal(corrected.project.blocks[1]!.design.color, "#000000");
  assert.ok(
    !inspectProject(corrected.project).some(
      (value) => value.blockId === child.id && value.code === "CONTRAST",
    ),
  );
  child.design.background = "#ffffff";
  child.design.color = "#00000010";
  assert.ok(
    inspectProject(p).some(
      (value) => value.blockId === child.id && value.code === "CONTRAST",
    ),
  );
  child.design.color = "#12345";
  assert.throws(() => parseProject(p), /HEX/);
});
