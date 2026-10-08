import test from "node:test";
import assert from "node:assert/strict";
import { createBlock, createProject } from "../src/domain/catalog";
import { mergeProjects } from "../src/infrastructure/projectMerge";
const fixture = () => {
  const base = createProject("공동 편집");
  base.blocks.push(createBlock("hero", base, base.pages[0]!.id));
  return base;
};
test("three-way merge keeps independent block and brand edits", () => {
  const base = fixture(),
    local = structuredClone(base),
    remote = structuredClone(base);
  local.blocks[0]!.props.title = "이 기기 제목";
  remote.theme.brandColor = "#112233";
  remote.revision++;
  const result = mergeProjects(base, local, remote);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.project?.blocks[0]?.props.title, "이 기기 제목");
  assert.equal(result.project?.theme.brandColor, "#112233");
  assert.equal(result.project?.revision, remote.revision + 1);
});

test("merge revision stays above later offline edits and the accepted server mutation", () => {
  const base = fixture(),
    local = structuredClone(base),
    remote = structuredClone(base);
  local.revision = 10;
  local.blocks[0]!.props.title = "계속 추가한 로컬 편집";
  remote.revision = 3;
  remote.theme.brandColor = "#223344";
  const result = mergeProjects(base, local, remote);
  assert.equal(result.error, null);
  assert.equal(result.project?.revision, 11);
  assert.equal(result.project?.blocks[0]?.props.title, "계속 추가한 로컬 편집");
  assert.equal(result.project?.theme.brandColor, "#223344");
});
test("overlapping field edits require a concrete choice and keep stable IDs", () => {
  const base = fixture(),
    local = structuredClone(base),
    remote = structuredClone(base);
  local.blocks[0]!.props.title = "local";
  remote.blocks[0]!.props.title = "remote";
  const first = mergeProjects(base, local, remote);
  assert.equal(first.conflicts.length, 1);
  const resolved = mergeProjects(base, local, remote, {
    [first.conflicts[0]!.path]: "remote",
  });
  assert.equal(resolved.project?.blocks[0]?.props.title, "remote");
  assert.equal(resolved.project?.blocks[0]?.id, base.blocks[0]?.id);
});
test("delete versus changed block is reported instead of quietly losing the change", () => {
  const base = fixture(),
    local = structuredClone(base),
    remote = structuredClone(base);
  local.blocks = [];
  remote.blocks[0]!.props.body = "changed";
  const result = mergeProjects(base, local, remote);
  assert.ok(result.conflicts.some((c) => c.path.includes("/@")));
  const choices = Object.fromEntries(
    result.conflicts.map((c) => [c.path, "remote" as const]),
  );
  assert.equal(
    mergeProjects(base, local, remote, choices).project?.blocks[0]?.props.body,
    "changed",
  );
});
test("merge refuses a mismatched project or prototype path", () => {
  const base = fixture(),
    remote = structuredClone(base);
  remote.id = "another-project";
  assert.equal(mergeProjects(base, base, remote).project, null);
  const unsafe = structuredClone(base);
  unsafe.collections = [
    {
      id: "c",
      name: "c",
      path: "/c",
      records: [
        {
          id: "r",
          slug: "r",
          title: "r",
          body: "",
          category: "",
          imageId: "",
          status: "draft",
          publishedAt: "",
          fields: JSON.parse('{"__proto__":"unsafe"}') as Record<
            string,
            string
          >,
        },
      ],
    },
  ];
  assert.equal(mergeProjects(base, unsafe, base).project, null);
});
