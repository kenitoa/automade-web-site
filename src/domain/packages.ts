import type {
  Block,
  DeclarativeBlockPackage,
  FeaturePin,
  Project,
} from "./types";
import { getBlockDefinition, projectBlockDefinition } from "./blockRegistry";
import { parseProject, record, ValidationError } from "./validation";
import { createBlock } from "./catalog";
export interface CompatibilityReport {
  supported: boolean;
  issues: { code: string; message: string; blockId?: string }[];
  requiredPackages: FeaturePin[];
}
const packageId = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-z][a-z0-9.-]{1,99}$/.test(value))
    throw new ValidationError("패키지 ID를 확인하세요.");
  return value;
};
const version = (value: unknown): string => {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value))
    throw new ValidationError("패키지 버전은 숫자.숫자.숫자 형식입니다.");
  return value;
};
const text = (value: unknown, max = 2000): string => {
  if (typeof value !== "string" || value.length > max)
    throw new ValidationError("패키지 문구를 확인하세요.");
  return value;
};
export function parseFeaturePin(value: unknown): FeaturePin {
  const input = record(value);
  const integrity = text(input.integrity, 100);
  if (
    !/^sha256-[a-f0-9]{64}$/.test(integrity) &&
    !/^builtin:[a-z0-9.-]+:v\d+$/.test(integrity)
  )
    throw new ValidationError("패키지 무결성 값을 확인하세요.");
  return {
    packageId: packageId(input.packageId),
    version: version(input.version),
    integrity,
  };
}
export function parseDeclarativePackage(
  value: unknown,
): DeclarativeBlockPackage {
  const input = record(value);
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "id",
          "name",
          "version",
          "integrity",
          "protocol",
          "definitions",
          "dependencies",
          "release",
        ].includes(key),
    ) ||
    input.protocol !== 1 ||
    !Array.isArray(input.definitions) ||
    input.definitions.length < 1 ||
    input.definitions.length > 50
  )
    throw new ValidationError(
      "지원하는 선언형 패키지 계약이 필요합니다. 실행 코드와 임의 URL은 허용되지 않습니다.",
    );
  const pin = parseFeaturePin({
    packageId: input.id,
    version: input.version,
    integrity: input.integrity,
  });
  const definitions = input.definitions.map((value) => {
    const definition = record(value),
      template = definition.template;
    if (
      Object.keys(definition).some(
        (key) =>
          !["id", "name", "description", "template", "defaults"].includes(key),
      ) ||
      !["text", "cards", "faq", "pricing", "automade:timeline"].includes(
        String(template),
      )
    )
      throw new ValidationError(
        "승인된 표시 블록만 선언형 패키지에 사용할 수 있습니다.",
      );
    const id = text(definition.id, 100);
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new ValidationError("패키지 블록 ID를 확인하세요.");
    const defaults = record(definition.defaults);
    if (
      Object.keys(defaults).some(
        (key) =>
          !["title", "body", "primaryAction", "secondaryAction"].includes(key),
      )
    )
      throw new ValidationError("지원하지 않는 패키지 기본 설정입니다.");
    return {
      id,
      name: text(definition.name, 200),
      description: text(definition.description),
      template:
        template as DeclarativeBlockPackage["definitions"][number]["template"],
      defaults: Object.fromEntries(
        Object.entries(defaults).map(([key, value]) => [
          key,
          text(value, key === "body" ? 50000 : 1000),
        ]),
      ),
    };
  });
  if (new Set(definitions.map((item) => item.id)).size !== definitions.length)
    throw new ValidationError("패키지 블록 ID가 중복됩니다.");
  return {
    id: pin.packageId,
    name: text(input.name, 200),
    version: pin.version,
    integrity: pin.integrity,
    protocol: 1,
    definitions,
    ...(input.dependencies !== undefined
      ? { dependencies: parsePackageDependencies(input.dependencies) }
      : {}),
    ...(input.release !== undefined
      ? { release: parsePackageRelease(input.release) }
      : {}),
  };
}
function parsePackageDependencies(
  input: unknown,
): NonNullable<DeclarativeBlockPackage["dependencies"]> {
  if (!Array.isArray(input) || input.length > 50)
    throw new ValidationError("패키지 의존 목록을 확인하세요.");
  const dependencies = input.map((value) => {
    const entry = record(value),
      range = text(entry.range, 100);
    if (!/^[~^]?\d+\.\d+\.\d+$/.test(range))
      throw new ValidationError(
        "의존 버전은 정확한 버전 또는 ^/~ 범위를 사용하세요.",
      );
    return { packageId: packageId(entry.packageId), range };
  });
  if (
    new Set(dependencies.map((item) => item.packageId)).size !==
    dependencies.length
  )
    throw new ValidationError("의존 패키지가 중복됩니다.");
  return dependencies;
}
function parsePackageRelease(
  input: unknown,
): NonNullable<DeclarativeBlockPackage["release"]> {
  const value = record(input);
  for (const key of ["approved", "deprecated"])
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw new ValidationError("패키지 릴리스 상태를 확인하세요.");
  return {
    authorId: text(value.authorId, 100),
    reason: text(value.reason, 2000),
    ...(value.approved === undefined
      ? {}
      : { approved: value.approved as boolean }),
    ...(value.deprecated === undefined
      ? {}
      : { deprecated: value.deprecated as boolean }),
  };
}
export function packageVersionMatches(
  installed: string,
  range: string,
): boolean {
  const marker = range[0],
    minimum = range.replace(/^[~^]/, ""),
    a = installed.split(".").map(Number),
    b = minimum.split(".").map(Number);
  if (
    a.length !== 3 ||
    b.length !== 3 ||
    a.some((n) => !Number.isSafeInteger(n))
  )
    return false;
  const comparison = a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
  if (marker === "~") return a[0] === b[0] && a[1] === b[1] && comparison >= 0;
  if (marker === "^")
    return (
      comparison >= 0 &&
      (b[0]! > 0
        ? a[0] === b[0]
        : b[1]! > 0
          ? a[0] === 0 && a[1] === b[1]
          : installed === minimum)
    );
  return installed === minimum;
}
export function packageDependencyIssues(
  packages: DeclarativeBlockPackage[],
): string[] {
  const issues: string[] = [],
    byId = new Map(packages.map((pack) => [pack.id, pack])),
    visited = new Set<string>(),
    active = new Set<string>();
  const visit = (pack: DeclarativeBlockPackage) => {
    if (active.has(pack.id)) {
      issues.push(`순환 패키지 의존: ${pack.id}`);
      return;
    }
    if (visited.has(pack.id)) return;
    active.add(pack.id);
    for (const dependency of pack.dependencies ?? []) {
      const target = byId.get(dependency.packageId),
        builtin = [
          "automade.core",
          "automade.timeline",
          "automade.content",
        ].includes(dependency.packageId)
          ? "1.0.0"
          : undefined;
      if (!target && !builtin)
        issues.push(`누락된 의존 패키지: ${dependency.packageId}`);
      else if (
        !packageVersionMatches(target?.version ?? builtin!, dependency.range)
      )
        issues.push(
          `의존 버전 충돌: ${dependency.packageId} ${dependency.range}`,
        );
      if (target) visit(target);
    }
    active.delete(pack.id);
    visited.add(pack.id);
  };
  for (const pack of packages) {
    visit(pack);
    if (pack.release?.deprecated) issues.push(`지원 종료 패키지: ${pack.id}`);
    if (pack.release?.approved === false)
      issues.push(`승인되지 않은 패키지: ${pack.id}`);
  }
  return [...new Set(issues)];
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([key]) => key !== "integrity")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function packageIntegrity(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256-${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
export async function verifyPackageIntegrity(
  pack: DeclarativeBlockPackage,
): Promise<void> {
  if (pack.integrity !== (await packageIntegrity(pack)))
    throw new ValidationError("패키지 내용이 고정한 무결성 값과 다릅니다.");
}
/** Run before normalizing/importing; unsupported source is never mutated or silently resaved. */
export function preflightProject(value: unknown): CompatibilityReport {
  const source = record(value),
    issues: CompatibilityReport["issues"] = [],
    requiredPackages: FeaturePin[] = [];
  if (
    source.schemaVersion !== 1 &&
    source.schemaVersion !== 2 &&
    source.schemaVersion !== undefined
  )
    issues.push({
      code: "SCHEMA_UNSUPPORTED",
      message:
        "지원하지 않는 원본 형식입니다. 원본을 보존하고 호환되는 프로그램에서 여세요.",
    });
  const packs = Array.isArray(source.blockPackages) ? source.blockPackages : [];
  try {
    for (const message of packageDependencyIssues(
      packs.map(parseDeclarativePackage),
    ))
      issues.push({ code: "PACKAGE_DEPENDENCY", message });
  } catch (error) {
    issues.push({
      code: "PACKAGE_INVALID",
      message:
        error instanceof Error ? error.message : "패키지 계약을 확인하세요.",
    });
  }
  const pins = Array.isArray(source.featurePins) ? source.featurePins : [];
  for (const value of pins) {
    try {
      requiredPackages.push(parseFeaturePin(value));
    } catch (error) {
      issues.push({
        code: "PACKAGE_PIN_INVALID",
        message:
          error instanceof Error
            ? error.message
            : "패키지 고정 정보를 확인하세요.",
      });
    }
  }
  for (const value of Array.isArray(source.blocks) ? source.blocks : []) {
    const block = record(value),
      definition = getBlockDefinition(String(block.type));
    if (!definition && block.type !== "shape") {
      issues.push({
        code: "BLOCK_UNSUPPORTED",
        message: `필요한 블록 ${String(block.type)}을 지원하지 않습니다. 원본을 그대로 보존합니다.`,
        blockId: typeof block.id === "string" ? block.id : undefined,
      });
      continue;
    }
    if (
      definition &&
      block.definitionVersion !== undefined &&
      block.definitionVersion !== definition.version
    )
      issues.push({
        code: "BLOCK_VERSION_UNSUPPORTED",
        message: "블록 정의 버전을 지원하지 않습니다.",
        blockId: String(block.id),
      });
    if (block.type === "extension") {
      const reference = record(block.props).extensionDefinitionId,
        candidate = packs
          .map(record)
          .find(
            (pack) =>
              Array.isArray(pack.definitions) &&
              pack.definitions.some(
                (item) => `${pack.id}/${record(item).id}` === reference,
              ),
          );
      const pin = candidate
        ? requiredPackages.find((pin) => pin.packageId === candidate.id)
        : undefined;
      if (
        !candidate ||
        !pin ||
        pin.version !== candidate.version ||
        pin.integrity !== candidate.integrity
      )
        issues.push({
          code: "PACKAGE_MISSING",
          message:
            "패키지와 고정 버전이 필요합니다. 원본을 보존하고 설치 정보를 확인하세요.",
          blockId: String(block.id),
        });
    } else if (
      definition &&
      !requiredPackages.some((pin) => pin.packageId === definition.packageId)
    ) {
      requiredPackages.push({
        packageId: definition.packageId,
        version: definition.packageVersion,
        integrity: `builtin:${definition.packageId}:v1`,
      });
    }
  }
  for (const pin of requiredPackages) {
    const declared = packs
      .map(record)
      .find((pack) => pack.id === pin.packageId);
    if (
      declared
        ? declared.version !== pin.version ||
          declared.integrity !== pin.integrity
        : !(
            (pin.packageId === "automade.core" ||
              pin.packageId === "automade.timeline" ||
              pin.packageId === "automade.content") &&
            pin.version === "1.0.0" &&
            pin.integrity === `builtin:${pin.packageId}:v1`
          )
    )
      issues.push({
        code: "PACKAGE_VERSION_UNSUPPORTED",
        message: `패키지 ${pin.packageId}의 고정 버전을 사용할 수 없습니다.`,
      });
  }
  return { supported: !issues.length, issues, requiredPackages };
}
export function assertProjectCompatibility(value: unknown): void {
  const report = preflightProject(value);
  if (!report.supported)
    throw new ValidationError(
      report.issues.map((issue) => issue.message).join(" "),
    );
}
export function createPackageBlock(
  project: Project,
  packageId: string,
  definitionId: string,
  pageId: string,
): Block {
  const pack = project.blockPackages?.find((pack) => pack.id === packageId),
    definition = pack?.definitions.find((item) => item.id === definitionId);
  if (!pack || !definition)
    throw new ValidationError("설치된 패키지 블록을 선택하세요.");
  const block = createBlock(definition.template, project, pageId);
  block.type = "extension";
  block.name = definition.name;
  block.definitionVersion = 1;
  block.props.extensionDefinitionId = `${pack.id}/${definition.id}`;
  Object.assign(block.props, structuredClone(definition.defaults));
  return block;
}
export function blockEnvironmentIssues(
  project: Project,
  target: "static" | "node",
): string[] {
  return project.blocks
    .filter(
      (block) =>
        !block.hidden &&
        (block.pageId === "*" ||
          project.pages.some(
            (page) => page.id === block.pageId && page.published,
          )),
    )
    .flatMap((block) => {
      const definition = projectBlockDefinition(project, block);
      if (
        target === "static" &&
        (block.props.dataBinding ||
          project.collections?.some(
            (collection) =>
              collection.queryMode === "server" &&
              collection.id === block.props.collectionBinding?.collectionId,
          ))
      )
        return [`${block.name}: 서버 조회 연결은 node 실행 환경이 필요합니다.`];
      return definition?.environments.includes(target)
        ? []
        : [`${block.name}: ${target} 실행 환경을 지원하지 않습니다.`];
    })
    .concat(
      target === "static" &&
        (project.pages.some(
          (page) => page.published && page.access === "members",
        ) ||
          project.collections?.some(
            (collection) => collection.access === "members",
          ))
        ? ["회원 콘텐츠는 인증 서버가 있는 node 환경이 필요합니다."]
        : [],
    );
}
export interface PackageChangePreview {
  project: Project;
  changes: {
    blockId?: string;
    field: string;
    before: unknown;
    after: unknown;
  }[];
  affectedIds: string[];
  skippedIds: string[];
}
export function previewPackageUpdate(
  project: Project,
  input: unknown,
  selectedIds?: string[],
): PackageChangePreview {
  const pack = parseDeclarativePackage(input),
    previous = project.blockPackages?.find((item) => item.id === pack.id),
    next = structuredClone(project),
    changes: PackageChangePreview["changes"] = [],
    affectedIds: string[] = [],
    skippedIds: string[] = [];
  for (const block of next.blocks) {
    if (
      block.type !== "extension" ||
      !block.props.extensionDefinitionId?.startsWith(`${pack.id}/`)
    )
      continue;
    const id = block.props.extensionDefinitionId.slice(pack.id.length + 1),
      oldDefinition = previous?.definitions.find((item) => item.id === id),
      definition = pack.definitions.find((item) => item.id === id);
    if (
      !definition ||
      (oldDefinition && oldDefinition.template !== definition.template)
    )
      throw new ValidationError(
        "사용 중인 블록을 제거하거나 표시 유형을 변경할 수 없습니다. 원본을 보존하고 별도 변환을 검토하세요.",
      );
    if (block.locked || (selectedIds && !selectedIds.includes(block.id))) {
      skippedIds.push(block.id);
      continue;
    }
    for (const [key, value] of Object.entries(definition.defaults)) {
      const before = block.props[key as keyof typeof definition.defaults];
      if (
        oldDefinition &&
        before !==
          oldDefinition.defaults[key as keyof typeof definition.defaults]
      )
        continue;
      if (before !== value) {
        changes.push({
          blockId: block.id,
          field: `props.${key}`,
          before,
          after: value,
        });
        (block.props as unknown as Record<string, unknown>)[key] = value;
      }
    }
    affectedIds.push(block.id);
  }
  next.blockPackages = [
    ...(next.blockPackages ?? []).filter((item) => item.id !== pack.id),
    pack,
  ];
  next.featurePins = [
    ...(next.featurePins ?? []).filter((item) => item.packageId !== pack.id),
    { packageId: pack.id, version: pack.version, integrity: pack.integrity },
  ];
  changes.unshift({
    field: `blockPackages.${pack.id}.version`,
    before: previous?.version,
    after: pack.version,
  });
  return { project: parseProject(next), changes, affectedIds, skippedIds };
}
export function removePackage(
  project: Project,
  id: string,
  detach = false,
): Project {
  const next = structuredClone(project),
    pack = next.blockPackages?.find((item) => item.id === id);
  if (!pack) throw new ValidationError("설치된 패키지가 없습니다.");
  for (const block of next.blocks)
    if (
      block.type === "extension" &&
      block.props.extensionDefinitionId?.startsWith(`${id}/`)
    ) {
      if (!detach || block.locked)
        throw new ValidationError(
          "사용 중인 패키지는 블록 연결을 해제한 후 제거하세요.",
        );
      const definition = pack.definitions.find(
        (item) => `${id}/${item.id}` === block.props.extensionDefinitionId,
      );
      if (!definition)
        throw new ValidationError("원본 블록 유형을 복원할 수 없습니다.");
      block.type = definition.template;
      delete block.props.extensionDefinitionId;
    }
  next.blockPackages = next.blockPackages?.filter((item) => item.id !== id);
  next.featurePins = next.featurePins?.filter((item) => item.packageId !== id);
  return parseProject(next);
}
