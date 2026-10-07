import test from "node:test";
import assert from "node:assert/strict";
import { createProject, createBlock } from "../src/domain/catalog";
import { publicProject } from "../src/domain/publication";
import { html } from "../server/generator";
test("private pages, hidden ancestors and unused assets never enter public HTML", () => {
  const p = createProject("Public");
  const privatePage = {
    id: "private",
    title: "secret-page",
    path: "/private",
    description: "secret-description",
    published: false,
    home: false,
  };
  p.pages.push(privatePage);
  const secret = createBlock("text", p, privatePage.id);
  secret.props.body = "PRIVATE_CONTENT";
  const parent = createBlock("container", p, p.pages[0]!.id);
  parent.hidden = true;
  const child = createBlock("text", p, p.pages[0]!.id);
  child.parentId = parent.id;
  child.props.body = "HIDDEN_CHILD";
  p.blocks.push(secret, parent, child);
  p.assets.push({
    id: "unused",
    name: "secret",
    alt: "SECRET_ASSET",
    mime: "image/png",
    data: "data:image/png;base64,AAAA",
  });
  const pub = publicProject(p);
  assert.equal(pub.blocks.length, 0);
  assert.equal(pub.assets.length, 0);
  assert.equal(pub.pages.length, 1);
  const output = html(p);
  for (const value of [
    "PRIVATE_CONTENT",
    "HIDDEN_CHILD",
    "SECRET_ASSET",
    "secret-page",
  ])
    assert.ok(!output.includes(value));
  assert.equal(p.blocks.length, 3);
});
