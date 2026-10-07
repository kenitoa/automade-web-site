import test from "node:test";
import assert from "node:assert/strict";
import { createBlock, createProject } from "../src/domain/catalog";
import {
  parseProject,
  inspectProject,
  safeJson,
  validateForm,
  csv,
} from "../src/domain/validation";
import {
  canvasPoint,
  commit,
  deleteBlocks,
  deletePage,
  duplicateBlocks,
  historyChange,
  undo,
  redo,
} from "../src/domain/commands";
import {
  fromTemplate,
  suggestTemplate,
  TEMPLATES,
} from "../src/domain/templates";
const fixture = () => {
  const p = createProject("검증 사이트");
  p.settings.description = "검증용";
  p.blocks.push(createBlock("form", p, p.pages[0]!.id));
  return p;
};
test("all templates produce valid versioned projects", () => {
  for (const t of TEMPLATES) {
    const p = fromTemplate(t.id, "사이트", "설명");
    assert.deepEqual(parseProject(p), p);
    assert.equal(
      inspectProject(p).filter((i) => i.severity === "error").length,
      0,
    );
  }
});
test("legacy coordinates and IDs survive migration without fabricated data", () => {
  const p = parseProject({
    name: "기존",
    theme: { brandColor: "#256f6b" },
    canvas: { width: 1440, height: 900, gridSize: 60 },
    blocks: [
      {
        id: "old-form",
        type: "form",
        props: { title: "기존 문의", body: "안내" },
        layout: { x: 120, y: 180, width: 520, height: 360 },
      },
    ],
  });
  assert.equal(p.blocks[0]!.id, "old-form");
  assert.equal(p.blocks[0]!.layout.x, 120);
  assert.equal(p.blocks[0]!.props.menuMode, "blocks");
  assert.equal(p.blocks[0]!.props.dataSource, "none");
  assert.ok(inspectProject(p).some((i) => i.code === "FORM_TARGET"));
});
test("unknown future versions and non-finite coordinates are rejected", () => {
  assert.throws(() => parseProject({ ...fixture(), schemaVersion: 99 }));
  const p = fixture();
  p.blocks[0]!.layout.x = NaN;
  assert.throws(() => parseProject(p));
});
test("duplicate IDs, page paths and cyclic containers are rejected", () => {
  const p = fixture();
  p.blocks.push(structuredClone(p.blocks[0]!));
  assert.throws(() => parseProject(p));
  const q = fixture();
  q.pages.push({ ...q.pages[0]!, id: "other", home: false });
  assert.throws(() => parseProject(q));
  const r = fixture();
  const a = createBlock("container", r, r.pages[0]!.id),
    b = createBlock("container", r, r.pages[0]!.id);
  a.parentId = b.id;
  b.parentId = a.id;
  r.blocks.push(a, b);
  assert.throws(() => parseProject(r));
});
test("actions use IDs and unsafe links are rejected", () => {
  const p = fixture();
  p.blocks[0]!.props.secondary = {
    kind: "link",
    url: "javascript:alert(1)",
    newTab: false,
  };
  assert.throws(() => parseProject(p));
  p.blocks[0]!.props.secondary = { kind: "navigate", target: "missing" };
  assert.ok(inspectProject(p).some((i) => i.code === "ACTION_TARGET"));
});
test("form validation checks required values, email, choice and range", () => {
  const p = fixture();
  const f = p.blocks[0]!.props.fields;
  assert.ok(Object.keys(validateForm(f, {}).errors).length);
  assert.ok(
    validateForm(f, { name: "사람", email: "bad", message: "내용입니다" })
      .errors.email,
  );
  assert.equal(
    Object.keys(
      validateForm(f, {
        name: "사람",
        email: "user@test.dev",
        message: "문의 내용입니다",
      }).errors,
    ).length,
    0,
  );
  const field = {
    id: "n",
    label: "수량",
    type: "number" as const,
    required: true,
    placeholder: "",
    min: 1,
    max: 10,
    options: [],
  };
  assert.ok(validateForm([field], { n: "Infinity" }).errors.n);
});
test("coordinate conversion is stable at scaled zoom and offset", () => {
  assert.deepEqual(
    canvasPoint(
      250,
      150,
      { left: 50, top: 50, width: 400, height: 200 },
      { width: 800, height: 400 },
    ),
    { x: 400, y: 200 },
  );
});
test("undo and redo restore behavior while revision increases", () => {
  const p = fixture();
  const q = commit(p, (p) => (p.name = "수정"));
  const h = historyChange({ past: [], present: p, future: [] }, q);
  const u = undo(h);
  assert.equal(u.present.name, p.name);
  assert.ok(u.present.revision > q.revision);
  assert.equal(redo(u).present.name, "수정");
});
test("deleting a container removes descendants and undo restores them", () => {
  const p = fixture(),
    container = createBlock("container", p, p.pages[0]!.id);
  p.blocks[0]!.parentId = container.id;
  p.blocks.push(container);
  const next = deleteBlocks(p, [container.id]);
  assert.equal(next.blocks.length, 0);
  assert.equal(
    undo(historyChange({ past: [], present: p, future: [] }, next)).present
      .blocks.length,
    2,
  );
});
test("duplicating blocks remaps internal targets", () => {
  const p = fixture(),
    modal = createBlock("modal", p, p.pages[0]!.id);
  p.blocks.push(modal);
  p.blocks[0]!.props.secondary = { kind: "modal", target: modal.id };
  const q = duplicateBlocks(
    p,
    p.blocks.map((b) => b.id),
  );
  assert.equal(q.blocks.length, 4);
  const action = q.blocks[2]!.props.secondary;
  assert.equal(action.kind, "modal");
  if (action.kind === "modal") assert.equal(action.target, q.blocks[3]!.id);
});
test("page deletion clears target links and preserves one home", () => {
  const p = fromTemplate("company", "회사", "소개");
  const target = p.pages.find((x) => x.path === "/contact")!;
  const q = deletePage(p, target.id);
  assert.equal(
    q.blocks.find((b) => b.type === "hero")!.props.action.kind,
    "none",
  );
  assert.equal(q.pages.filter((x) => x.home).length, 1);
  assert.throws(() => deletePage(createProject(), "missing"));
});
test("CSV handles quotes/newlines and neutralizes spreadsheet formulas", () => {
  const value = csv(["열"], [["=1+1"], ["a,b"], ['quote"text'], ["a\nb"]]);
  assert.ok(value.startsWith("\ufeff"));
  assert.ok(value.includes("'=1+1"));
  assert.ok(value.includes('"a,b"'));
  assert.ok(value.includes('"quote""text"'));
});
test("JSON embedded in HTML cannot terminate script", () => {
  const dangerous = {
    text: "</script><img src=x onerror=alert(1)>",
    line: "\u2028",
  };
  const encoded = safeJson(dangerous);
  assert.ok(!encoded.includes("<"));
  assert.deepEqual(JSON.parse(encoded), dangerous);
});
test("brief planner selects explicit supported templates", () => {
  assert.equal(suggestTemplate("업무 데이터 표와 차트"), "dashboard");
  assert.equal(suggestTemplate("포트폴리오 작업 소개"), "portfolio");
});

test("wrong boolean types, reserved routes and colliding normalized paths are rejected", () => {
  const p = createProject();
  assert.throws(() =>
    parseProject({ ...p, pages: [{ ...p.pages[0], published: "true" }] }),
  );
  assert.throws(() =>
    parseProject({
      ...p,
      pages: [
        ...p.pages,
        {
          id: "api",
          title: "Bad",
          path: "/api",
          home: false,
          published: true,
          description: "",
        },
      ],
    }),
  );
  assert.throws(() =>
    parseProject({
      ...p,
      pages: [
        ...p.pages,
        {
          id: "a",
          title: "A",
          path: "/work/",
          home: false,
          published: true,
          description: "",
        },
        {
          id: "b",
          title: "B",
          path: "/work",
          home: false,
          published: true,
          description: "",
        },
      ],
    }),
  );
});
