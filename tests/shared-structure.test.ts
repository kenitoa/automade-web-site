import test from "node:test";
import assert from "node:assert/strict";
import { createBlock, createProject } from "../src/domain/catalog";
import {
  instantiateComponent,
  previewComponentStructureUpdate,
} from "../src/domain/shared";
import { parseProject } from "../src/domain/validation";
import { publicProject } from "../src/domain/publication";

test("shared tree updates add, move and remove blocks while preserving stable IDs and local overrides", () => {
  let project = createProject();
  const root = createBlock("container", project, project.pages[0]!.id),
    child = createBlock("text", project, project.pages[0]!.id),
    removed = createBlock("text", project, project.pages[0]!.id);
  child.parentId = root.id;
  removed.parentId = root.id;
  const component = {
    id: "shared_tree",
    name: "Shared tree",
    version: 1,
    blocks: [root, child, removed],
  };
  project = instantiateComponent(project, component, project.pages[0]!.id);
  const rootId = project.blocks[0]!.id,
    childId = project.blocks[1]!.id,
    removedId = project.blocks[2]!.id;
  project.blocks[1]!.props.title = "Local title";
  const added = createBlock("text", project, project.pages[0]!.id);
  added.props.title = "New child";
  added.parentId = root.id;
  added.props.action = { kind: "scroll", target: child.id };
  const updatedChild = structuredClone(child);
  updatedChild.parentId = null;
  updatedChild.props.title = "Upstream title";
  updatedChild.props.body = "New upstream body";
  const update = {
    ...component,
    version: 2,
    blocks: [root, added, updatedChild],
  };
  const preview = previewComponentStructureUpdate(project, update);
  const next = parseProject(preview.project),
    local = next.blocks.find((block) => block.id === childId)!;
  assert.equal(local.parentId, null);
  assert.equal(local.props.title, "Local title");
  assert.equal(local.props.body, "New upstream body");
  assert.ok(
    preview.conflicts!.some(
      (conflict) =>
        conflict.blockId === childId && conflict.field === "props.title",
    ),
  );
  assert.equal(
    next.blocks.some((block) => block.id === removedId),
    false,
  );
  const newChild = next.blocks.find(
    (block) => block.componentLink?.sourceBlockId === added.id,
  )!;
  assert.equal(newChild.parentId, rootId);
  assert.deepEqual(newChild.props.action, { kind: "scroll", target: childId });
  assert.equal(
    next.blocks.find((block) => block.id === rootId)!.componentLink?.version,
    2,
  );
  assert.equal(next.componentHistory?.length, 2);
  assert.equal(publicProject(next).componentHistory, undefined);
  assert.equal(project.blocks.length, 3);
});

test("removed referenced and operational blocks detach while protected fields survive tree changes", () => {
  let project = createProject();
  const root = createBlock("container", project, project.pages[0]!.id),
    form = createBlock("form", project, project.pages[0]!.id),
    text = createBlock("text", project, project.pages[0]!.id);
  form.parentId = root.id;
  text.parentId = root.id;
  const component = {
    id: "operating_tree",
    name: "Operating tree",
    version: 1,
    blocks: [root, form, text],
  };
  project = instantiateComponent(project, component, project.pages[0]!.id);
  const formId = project.blocks[1]!.id,
    textId = project.blocks[2]!.id;
  const outside = createBlock("hero", project, project.pages[0]!.id);
  outside.props.action = { kind: "scroll", target: textId };
  project.blocks.push(outside);
  const preview = previewComponentStructureUpdate(project, {
    ...component,
    version: 2,
    blocks: [root],
  });
  assert.ok(
    preview.project.blocks.some(
      (block) => block.id === formId && !block.componentLink,
    ),
  );
  assert.ok(
    preview.project.blocks.some(
      (block) => block.id === textId && !block.componentLink,
    ),
  );
  assert.deepEqual(
    preview.project.blocks.find((block) => block.id === outside.id)!.props
      .action,
    outside.props.action,
  );
  assert.ok(
    preview.conflicts!.filter((conflict) => conflict.field === "block")
      .length >= 2,
  );
});
