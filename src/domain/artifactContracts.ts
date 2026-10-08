import { record, ValidationError } from "./validation";
export interface ArtifactFile {
  path: string;
  sha256: string;
}
export interface ArtifactRuntime {
  path: string;
  sha256: string;
  version: string;
  platform: string;
  arch: string;
  sqlite: string;
  icu: string;
  tz: string;
}
export interface ArtifactContract {
  protocol: 2;
  schemaVersion: 2;
  generatorVersion: string;
  target: "node";
  node: string;
  databaseMigration: number;
  packages: unknown[];
  sourceFiles: ArtifactFile[];
  packageLockSha256: string;
  runtime: ArtifactRuntime;
  compiledFiles: ArtifactFile[];
  supportedHosts: { platform: string; arch: string }[];
  licenses: ArtifactFile[];
  build?: {
    sourceHash: string;
    serviceBuildHash: string;
    commit: string | null;
    node: string;
    platform: string;
    arch: string;
  };
}
const text = (input: unknown, max = 300): string => {
  if (typeof input !== "string" || input.length > max)
    throw new ValidationError("결과물 계약 문자열을 확인하세요.");
  return input;
};
const digest = (input: unknown): string => {
  const value = text(input, 64);
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new ValidationError("결과물 SHA256을 확인하세요.");
  return value;
};
export function artifactPath(input: unknown): string {
  const value = text(input, 600);
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..") ||
    /^[A-Za-z]:/.test(value)
  )
    throw new ValidationError("결과물 상대 경로를 확인하세요.");
  return value;
}
function files(input: unknown): ArtifactFile[] {
  if (!Array.isArray(input) || input.length > 50000)
    throw new ValidationError("결과물 파일 목록을 확인하세요.");
  const result = input.map((value) => {
    const entry = record(value);
    return { path: artifactPath(entry.path), sha256: digest(entry.sha256) };
  });
  if (new Set(result.map((file) => file.path)).size !== result.length)
    throw new ValidationError("결과물 파일 경로가 중복됩니다.");
  return result;
}
export function parseArtifactContract(input: unknown): ArtifactContract {
  const value = record(input),
    runtime = record(value.runtime);
  if (
    value.protocol !== 2 ||
    value.schemaVersion !== 2 ||
    value.target !== "node" ||
    !Number.isSafeInteger(value.databaseMigration) ||
    Number(value.databaseMigration) < 1 ||
    Number(value.databaseMigration) > 15 ||
    !Array.isArray(value.packages) ||
    !Array.isArray(value.supportedHosts) ||
    value.supportedHosts.length > 20
  )
    throw new ValidationError("지원하는 결과물 계약이 필요합니다.");
  return {
    protocol: 2,
    schemaVersion: 2,
    generatorVersion: text(value.generatorVersion),
    target: "node",
    node: text(value.node),
    databaseMigration: Number(value.databaseMigration),
    packages: value.packages,
    sourceFiles: files(value.sourceFiles),
    packageLockSha256: digest(value.packageLockSha256),
    runtime: {
      path: artifactPath(runtime.path),
      sha256: digest(runtime.sha256),
      version: text(runtime.version),
      platform: text(runtime.platform),
      arch: text(runtime.arch),
      sqlite: text(runtime.sqlite),
      icu: text(runtime.icu),
      tz: text(runtime.tz),
    },
    compiledFiles: files(value.compiledFiles),
    supportedHosts: value.supportedHosts.map((input) => {
      const host = record(input);
      return { platform: text(host.platform), arch: text(host.arch) };
    }),
    licenses: files(value.licenses),
    ...(value.build === undefined
      ? {}
      : { build: parseArtifactBuild(value.build) }),
  };
}
function parseArtifactBuild(
  input: unknown,
): NonNullable<ArtifactContract["build"]> {
  const value = record(input),
    commit = value.commit;
  if (
    commit !== null &&
    (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit))
  )
    throw new ValidationError("검증된 빌드 커밋을 확인하세요.");
  return {
    sourceHash: digest(value.sourceHash),
    serviceBuildHash: digest(value.serviceBuildHash),
    commit,
    node: text(value.node),
    platform: text(value.platform),
    arch: text(value.arch),
  };
}
export interface ReleaseBundleContract {
  id: string;
  artifactSha256: string;
  artifactContractSha256: string;
  sourceRevision: number;
  publicationSequence: number;
  packagePins: { packageId: string; version: string; integrity: string }[];
  graphRevision: number;
  dataSchema: number;
  seoMode: "dynamic-binding" | "static-variant";
  createdAt: string;
}
export interface EnvironmentBindingContract {
  id: string;
  releaseBundleId: string;
  artifactSha256: string;
  environmentId: string;
  dataKey: string;
  configRevision: number;
  publicOrigin: string;
  bindingSha256: string;
  seoMode: ReleaseBundleContract["seoMode"];
  variantOf?: string;
}
/** Promotion eligibility is explicit; environment settings and data are separate from content bytes. */
export function releaseBindingIssues(
  bundle: ReleaseBundleContract,
  binding: EnvironmentBindingContract,
  expectedConfigRevision: number,
): string[] {
  const issues: string[] = [];
  if (
    binding.artifactSha256 !== bundle.artifactSha256 &&
    binding.seoMode !== "static-variant"
  )
    issues.push("동일 콘텐츠 결과물 해시가 필요합니다.");
  if (binding.releaseBundleId !== bundle.id)
    issues.push("다른 릴리스 묶음입니다.");
  if (binding.configRevision !== expectedConfigRevision)
    issues.push("환경 설정이 변경되었습니다.");
  if (binding.seoMode === "static-variant" && !binding.variantOf)
    issues.push("정적 SEO 변형은 원래 결과물 연결이 필요합니다.");
  return issues;
}
