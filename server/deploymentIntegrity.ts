import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { artifactPath } from "../src/domain/artifactContracts";
import { record, ValidationError } from "../src/domain/validation";
import { verifyDeploymentSignature } from "./artifactSigning";
export interface DeploymentContract {
  protocol: 1;
  mode: "deployment";
  projectId: string;
  revision: number;
  releaseId: string;
  buildHash: string;
  buildCommit: string | null;
  files: { path: string; sha256: string }[];
}
const required = [
  "site-server.mjs",
  "project.interface.json",
  ".release.json",
  "dist/index.html",
  "dist/assets/site.js",
];
const allowed = (value: string): boolean =>
  value.startsWith("dist/") ||
  [
    "site-server.mjs",
    "project.interface.json",
    ".release.json",
    "Dockerfile",
    "compose.yml",
    ".dockerignore",
  ].includes(value);
export function parseDeploymentContract(value: unknown): DeploymentContract {
  const input = record(value);
  if (
    input.protocol !== 1 ||
    input.mode !== "deployment" ||
    typeof input.projectId !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(input.projectId) ||
    !Number.isSafeInteger(input.revision) ||
    Number(input.revision) < 0 ||
    typeof input.releaseId !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(input.releaseId) ||
    typeof input.buildHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.buildHash) ||
    (input.buildCommit !== null &&
      (typeof input.buildCommit !== "string" ||
        !/^[a-f0-9]{40}$/.test(input.buildCommit))) ||
    !Array.isArray(input.files) ||
    input.files.length > 2000
  )
    throw new ValidationError("공개 배포 무결성 계약을 확인하세요.");
  const files = input.files.map((item) => {
    const file = record(item),
      relative = artifactPath(file.path);
    if (
      !allowed(relative) ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new ValidationError("공개 배포 파일과 해시를 확인하세요.");
    return { path: relative, sha256: file.sha256 };
  });
  if (
    new Set(files.map((item) => item.path)).size !== files.length ||
    required.some((file) => !files.some((item) => item.path === file))
  )
    throw new ValidationError("공개 배포 필수 파일이 없거나 중복되었습니다.");
  return {
    protocol: 1,
    mode: "deployment",
    projectId: input.projectId,
    revision: Number(input.revision),
    releaseId: input.releaseId,
    buildHash: input.buildHash,
    buildCommit: input.buildCommit,
    files,
  };
}
export async function writeDeploymentContract(
  directory: string,
  metadata: Omit<DeploymentContract, "protocol" | "mode" | "files">,
): Promise<DeploymentContract> {
  const root = await realpath(directory),
    files: DeploymentContract["files"] = [];
  const add = async (relative: string): Promise<void> => {
    const target = path.join(root, relative);
    if ((await lstat(target)).isSymbolicLink())
      throw new Error("Symbolic deployment file is not accepted");
    const resolved = await realpath(target);
    if (!resolved.startsWith(root + path.sep))
      throw new Error("Deployment file escapes output");
    files.push({
      path: relative,
      sha256: createHash("sha256")
        .update(await readFile(target))
        .digest("hex"),
    });
  };
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      if (entry.isSymbolicLink())
        throw new Error("Symbolic deployment output is not accepted");
      if (entry.isDirectory()) await walk(`${relative}/${entry.name}`);
      else if (entry.isFile()) await add(`${relative}/${entry.name}`);
    }
  };
  await walk("dist");
  for (const file of [
    "site-server.mjs",
    "project.interface.json",
    ".release.json",
    "Dockerfile",
    "compose.yml",
    ".dockerignore",
  ])
    await add(file);
  const contract = parseDeploymentContract({
    protocol: 1,
    mode: "deployment",
    ...metadata,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  });
  const temporary = path.join(root, `.deployment-contract-${randomUUID()}.json`);
  try {
    await writeFile(temporary, JSON.stringify(contract, null, 2), { flag: "wx" });
    await rename(temporary, path.join(root, "deployment.contract.json"));
  } finally {
    await rm(temporary, { force: true });
  }
  return contract;
}
export async function verifyDeploymentIntegrity(
  directory: string,
  expected: { buildHash?: string | null; buildCommit?: string | null } = {},
): Promise<{
  supported: boolean;
  errors: string[];
  contract: DeploymentContract;
}> {
  const root = await realpath(directory),
    contract = parseDeploymentContract(
      JSON.parse(
        await readFile(path.join(root, "deployment.contract.json"), "utf8"),
      ),
    ),
    errors: string[] = [];
  let bytes = 0;
  for (const entry of contract.files) {
    try {
      let current = root;
      for (const segment of entry.path.split("/")) {
        current = path.join(current, segment);
        if ((await lstat(current)).isSymbolicLink())
          throw new Error("Symbolic deployment paths are not accepted");
      }
      const resolved = await realpath(current),
        info = await lstat(current);
      if (
        !resolved.startsWith(root + path.sep) ||
        !info.isFile() ||
        (bytes += info.size) > 25_000_000
      )
        throw new Error("Deployment file exceeds permitted output");
      if (
        createHash("sha256")
          .update(await readFile(current))
          .digest("hex") !== entry.sha256
      )
        errors.push(`Deployment integrity mismatch: ${entry.path}`);
    } catch (error) {
      errors.push(
        `${entry.path}: ${error instanceof Error ? error.message : "unreadable"}`,
      );
    }
  }
  if (
    expected.buildHash !== undefined &&
    expected.buildHash !== contract.buildHash
  )
    errors.push("Compiled build hash differs from deployment contract");
  if (
    expected.buildCommit !== undefined &&
    expected.buildCommit !== contract.buildCommit
  )
    errors.push("Compiled build commit differs from deployment contract");
  const node = process.versions.node.split(".").map(Number);
  if ((node[0] ?? 0) < 22 || (node[0] === 22 && (node[1] ?? 0) < 16))
    errors.push("Deployment requires Node.js22.16 or later");
  try {
    const signature = JSON.parse(
        await readFile(path.join(root, "deployment.signature.json"), "utf8"),
      ),
      trusted = process.env.ARTIFACT_TRUSTED_PUBLIC_KEY_FILE
        ? await readFile(
            path.resolve(process.env.ARTIFACT_TRUSTED_PUBLIC_KEY_FILE),
            "utf8",
          )
        : undefined,
      verified = Boolean(
        trusted && verifyDeploymentSignature(contract, signature, trusted),
      );
    if (
      (trusted || process.env.ARTIFACT_REQUIRE_SIGNATURE === "true") &&
      !verified
    )
      errors.push(
        "Deployment signature requires a matching externally trusted key",
      );
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" ||
      process.env.ARTIFACT_REQUIRE_SIGNATURE === "true"
    )
      errors.push("Deployment signature verification failed");
  }
  return { supported: errors.length === 0, errors, contract };
}
