import test from "node:test";
import assert from "node:assert/strict";
import { createBlock, createProject } from "../src/domain/catalog";
import { guidePosition, setHomePage, deletePage } from "../src/domain/commands";
import { parseProject } from "../src/domain/validation";
import { locale } from "../src/runtime/locale";
test("guide snapping aligns edges and centers within visual tolerance", () => {
  const p = createProject();
  const a = createBlock("text", p, p.pages[0]!.id),
    b = createBlock("text", p, p.pages[0]!.id);
  for (const block of [a, b]) block.layout.mode = "absolute";
  a.layout.width = 100;
  a.layout.height = 100;
  b.layout = { ...b.layout, x: 300, y: 300, width: 100, height: 100 };
  const close = guidePosition(a, 298, 202, [b], 1440, 6);
  assert.equal(close.x, 300);
  assert.equal(close.y, 200);
  assert.ok(close.guides.some((g) => g.axis === "x" && g.value === 300));
  const far = guidePosition(a, 220, 220, [b], 1440, 6);
  assert.equal(far.x, 220);
  assert.equal(far.y, 220);
});
test("runtime UI supports English and custom phrases without losing author content", () => {
  const p = createProject();
  p.settings.language = "en";
  assert.equal(locale(p, "검색"), "Search");
  p.settings.customLanguageText = JSON.stringify({ 검색: "Find records" });
  assert.equal(locale(p, "검색"), "Find records");
  p.settings.customLanguageText = "Legacy note";
  assert.equal(locale(p, "검색"), "Search");
});

test("changing or deleting the home page preserves canonical public routes", () => {
  const p = createProject();
  p.pages.push({
    id: "work",
    title: "Work",
    path: "/work",
    description: "",
    published: false,
    home: false,
  });
  const changed = setHomePage(p, "work");
  assert.equal(
    parseProject(changed).pages.find((page) => page.id === "work")!.path,
    "/",
  );
  assert.equal(changed.pages[0]!.path, "/work");
  const deleted = deletePage(changed, "work");
  assert.equal(parseProject(deleted).pages[0]!.path, "/");
});
