import test from "node:test";
import assert from "node:assert/strict";
import { createProject } from "../src/domain/catalog";
import { verifyAssets } from "../server/generator";

test("saving lightweight blob references does not relax materialized export MIME verification", () => {
  const project = createProject();
  project.assets.push({
    id: "shared",
    name: "Shared",
    alt: "Shared image",
    mime: "image/png",
    data: "",
    blobRef: { id: "blob", projectId: project.id, sha256: "a".repeat(64) },
  });
  assert.throws(() => verifyAssets(project), /MIME/);
  assert.doesNotThrow(() =>
    verifyAssets(project, { allowBlobReferences: true }),
  );
  project.assets[0]!.data = "data:image/png;base64,aW52YWxpZA==";
  assert.throws(
    () => verifyAssets(project, { allowBlobReferences: true }),
    /MIME/,
  );
  project.assets[0]!.data = "";
  project.assets[0]!.blobRef!.sha256 = "invalid";
  assert.throws(
    () => verifyAssets(project, { allowBlobReferences: true }),
    /MIME/,
  );
});
