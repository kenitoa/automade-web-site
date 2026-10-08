import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { checkArtifact } from "../scripts/check-extension";
import {
  parseArtifactContract,
  artifactPath,
} from "../src/domain/artifactContracts";
import {
  signArtifactContract,
  verifyArtifactSignature,
} from "../server/artifactSigning";
import { verifyArtifactIntegrity } from "../server/artifactIntegrity";

test("protocol2 artifact validation detects source, runtime, compiled and lock tampering", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "automade-integrity-"));
  try {
    const file = async (relative: string, bytes: string) => {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), bytes);
      return {
        path: relative,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    };
    const source = await file("server/siteServer.ts", "source"),
      runtime = await file("runtime/node", "runtime"),
      compiled = await file("site-server.mjs", "compiled"),
      license = await file("runtime/LICENSE", "license"),
      lock = await file("package-lock.json", "{}");
    const contract = {
      protocol: 2,
      schemaVersion: 2,
      generatorVersion: "2.1.0",
      target: "node",
      node: ">=22.16.0",
      databaseMigration: 15,
      packages: [],
      sourceFiles: [source],
      packageLockSha256: lock.sha256,
      runtime: {
        ...runtime,
        version: process.version,
        platform: process.platform,
        arch: process.arch,
        sqlite: process.versions.sqlite,
        icu: process.versions.icu,
        tz: process.versions.tz,
      },
      compiledFiles: [compiled],
      supportedHosts: [{ platform: process.platform, arch: process.arch }],
      licenses: [license],
    };
    await file("artifact.contract.json", JSON.stringify(contract));
    assert.equal((await checkArtifact(root)).supported, true);
    const signer = generateKeyPairSync("ed25519"),
      privateKey = signer.privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
      publicKey = signer.publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
      signature = signArtifactContract(
        contract,
        privateKey,
        "test-operator",
        "test-key",
      );
    assert.equal(verifyArtifactSignature(contract, signature, publicKey), true);
    assert.equal(
      verifyArtifactSignature(
        contract,
        { ...signature, signerId: "spoofed" },
        publicKey,
      ),
      false,
    );
    await writeFile(
      path.join(root, "artifact.signature.json"),
      JSON.stringify(signature),
    );
    assert.equal(
      (await verifyArtifactIntegrity(root, { requireSignature: true }))
        .supported,
      false,
    );
    assert.equal(
      (
        await verifyArtifactIntegrity(root, {
          requireSignature: true,
          trustedPublicKey: publicKey,
        })
      ).supported,
      true,
    );
    assert.equal(
      (
        await verifyArtifactIntegrity(root, {
          trustedPublicKey: generateKeyPairSync("ed25519")
            .publicKey.export({ format: "pem", type: "spki" })
            .toString(),
        })
      ).supported,
      false,
    );
    await rm(path.join(root, "artifact.signature.json"));
    for (const relative of [
      source.path,
      runtime.path,
      compiled.path,
      license.path,
      lock.path,
    ]) {
      const original = await readFile(path.join(root, relative));
      await writeFile(path.join(root, relative), "modified");
      const result = await checkArtifact(root);
      assert.equal(result.supported, false, relative);
      assert.ok(
        result.errors.some(
          (error) =>
            error.includes(relative) ||
            (relative === lock.path && error.includes("lock")),
        ),
      );
      await writeFile(path.join(root, relative), original);
    }
    assert.throws(
      () =>
        parseArtifactContract({ ...contract, sourceFiles: [source, source] }),
      /중복/,
    );
    assert.throws(() => artifactPath("../data.sqlite"));
    assert.throws(() => artifactPath("C:/keys/private.key"));
    assert.throws(() =>
      parseArtifactContract({ ...contract, databaseMigration: 16 }),
    );
    const incompatible = {
      ...contract,
      supportedHosts: [{ platform: "unknown", arch: "other" }],
    };
    await writeFile(
      path.join(root, "artifact.contract.json"),
      JSON.stringify(incompatible),
    );
    assert.equal((await checkArtifact(root)).supported, false);
    await writeFile(
      path.join(root, "artifact.contract.json"),
      JSON.stringify({ protocol: 1, sourceFiles: [source] }),
    );
    assert.deepEqual(await checkArtifact(root), {
      protocol: 1,
      supported: true,
      errors: [],
    });
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});
