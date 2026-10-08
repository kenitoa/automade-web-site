import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  artifactPath,
  parseArtifactContract,
} from "../src/domain/artifactContracts";
import { record } from "../src/domain/validation";
import {
  parseArtifactSignature,
  verifyArtifactSignature,
} from "./artifactSigning";

/** Hashes detect damaged or changed files. Publisher identity requires a separately trusted signature. */
export async function verifyArtifactIntegrity(
  directory: string,
  options: { trustedPublicKey?: string; requireSignature?: boolean } = {},
): Promise<{
  protocol: number;
  supported: boolean;
  errors: string[];
  identitySignature?: { signerId: string; keyId: string; verified: boolean };
}> {
  const root = await realpath(directory);
  const raw = record(
    JSON.parse(
      await readFile(path.join(root, "artifact.contract.json"), "utf8"),
    ),
  );
  const protocol = Number(raw.protocol),
    errors: string[] = [];
  if (protocol !== 1 && protocol !== 2)
    return {
      protocol,
      supported: false,
      errors: ["Unsupported artifact protocol"],
    };
  const contract = protocol === 2 ? parseArtifactContract(raw) : null;
  const entries = contract
    ? [
        ...contract.sourceFiles,
        ...contract.compiledFiles,
        contract.runtime,
        ...contract.licenses,
      ]
    : Array.isArray(raw.sourceFiles)
      ? raw.sourceFiles.map((value) => {
          const file = record(value);
          return { path: artifactPath(file.path), sha256: String(file.sha256) };
        })
      : [];
  for (const entry of entries) {
    try {
      const relative = artifactPath(entry.path),
        file = path.resolve(root, relative);
      let current = root;
      for (const segment of relative.split("/")) {
        current = path.join(current, segment);
        if ((await lstat(current)).isSymbolicLink())
          throw new Error("Symbolic artifact paths are not accepted");
      }
      const resolved = await realpath(file);
      if (!resolved.startsWith(root + path.sep))
        throw new Error("Artifact path escapes root");
      const info = await lstat(file);
      if (!info.isFile() || info.size > 300_000_000)
        throw new Error("Artifact file must be a bounded regular file");
      if (
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex") !== entry.sha256
      )
        errors.push(`Integrity mismatch: ${entry.path}`);
    } catch (error) {
      errors.push(
        `${entry.path}: ${error instanceof Error ? error.message : "unreadable"}`,
      );
    }
  }
  if (contract) {
    if (
      contract.build &&
      createHash("sha256")
        .update(
          JSON.stringify(
            contract.sourceFiles
              .slice()
              .sort((a, b) => a.path.localeCompare(b.path)),
          ),
        )
        .digest("hex") !== contract.build.sourceHash
    )
      errors.push("Artifact build source hash mismatch");
    if (
      createHash("sha256")
        .update(await readFile(path.join(root, "package-lock.json")))
        .digest("hex") !== contract.packageLockSha256
    )
      errors.push("Package lock mismatch");
    if (
      !contract.supportedHosts.some(
        (host) =>
          host.platform === process.platform && host.arch === process.arch,
      )
    )
      errors.push("This artifact does not support the current OS/architecture");
    const version = process.versions.node.split(".").map(Number);
    if (
      (version[0] ?? 0) < 22 ||
      ((version[0] ?? 0) === 22 && (version[1] ?? 0) < 16)
    )
      errors.push("Node.js 22.16 or later is required");
  }
  let identitySignature:
    { signerId: string; keyId: string; verified: boolean } | undefined;
  const requireSignature =
    options.requireSignature ??
    process.env.ARTIFACT_REQUIRE_SIGNATURE === "true";
  try {
    const signature = parseArtifactSignature(
      JSON.parse(
        await readFile(path.join(root, "artifact.signature.json"), "utf8"),
      ),
    );
    const trusted =
      options.trustedPublicKey ??
      (process.env.ARTIFACT_TRUSTED_PUBLIC_KEY_FILE
        ? await readFile(
            path.resolve(process.env.ARTIFACT_TRUSTED_PUBLIC_KEY_FILE),
            "utf8",
          )
        : undefined);
    const verified = Boolean(
      trusted && verifyArtifactSignature(raw, signature, trusted),
    );
    identitySignature = {
      signerId: signature.signerId,
      keyId: signature.keyId,
      verified,
    };
    if (trusted && !verified)
      errors.push("Artifact publisher signature mismatch");
    if (requireSignature && !verified)
      errors.push(
        "Artifact publisher signature requires an externally trusted key",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || requireSignature)
      errors.push(
        error instanceof Error
          ? error.message
          : "Artifact signature verification failed",
      );
  }
  return {
    protocol,
    supported: errors.length === 0,
    errors,
    ...(identitySignature ? { identitySignature } : {}),
  };
}
