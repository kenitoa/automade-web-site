import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  parseDeclarativePackage,
  verifyPackageIntegrity,
  packageIntegrity,
  preflightProject,
  blockEnvironmentIssues,
} from "../src/domain/packages";
import { parseProject, record } from "../src/domain/validation";
import { verifyArtifactIntegrity } from "../server/artifactIntegrity";
export async function checkArtifact(
  directory: string,
): Promise<{ supported: boolean; errors: string[]; protocol: number }> {
  return verifyArtifactIntegrity(directory);
}

export async function checkExtension(
  value: unknown,
  options: {
    project?: boolean;
    target?: "static" | "node";
    printIntegrity?: boolean;
  } = {},
): Promise<{
  supported: boolean;
  packages: string[];
  integrity?: string;
  errors: string[];
}> {
  if (options.project) {
    const source = record(value),
      document = source.project ?? source;
    const compatibility = preflightProject(document);
    if (!compatibility.supported)
      return {
        supported: false,
        packages: compatibility.requiredPackages.map(
          (pin) => `${pin.packageId}@${pin.version}`,
        ),
        errors: compatibility.issues.map((issue) => issue.message),
      };
    const project = parseProject(document);
    for (const pack of project.blockPackages ?? [])
      await verifyPackageIntegrity(pack);
    const errors = blockEnvironmentIssues(project, options.target ?? "node");
    return {
      supported: errors.length === 0,
      packages: compatibility.requiredPackages.map(
        (pin) => `${pin.packageId}@${pin.version}`,
      ),
      errors,
    };
  }
  const manifest = parseDeclarativePackage(value);
  const integrity = await packageIntegrity(manifest);
  if (!options.printIntegrity) await verifyPackageIntegrity(manifest);
  return {
    supported: true,
    packages: [`${manifest.id}@${manifest.version}`],
    ...(options.printIntegrity ? { integrity } : {}),
    errors: [],
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2),
    file = args[0],
    flags = args.slice(1);
  if (
    !file ||
    file.startsWith("-") ||
    flags.some(
      (flag) =>
        ![
          "--project",
          "--target=static",
          "--target=node",
          "--print-integrity",
          "--artifact",
        ].includes(flag),
    ) ||
    (flags.includes("--project") && flags.includes("--print-integrity"))
  )
    throw new Error(
      "Usage: npm run extension:check -- manifest.json [--print-integrity] or project.interface.json --project [--target=node|static]",
    );
  const target = flags.includes("--target=static") ? "static" : "node";
  if (flags.includes("--artifact")) {
    const result = await checkArtifact(path.resolve(file));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (!result.supported) process.exitCode = 1;
    return;
  }
  const inputPath = path.resolve(file),
    info = await stat(inputPath);
  if (
    !info.isFile() ||
    info.size > (flags.includes("--project") ? 64_000_000 : 2_000_000)
  )
    throw new Error("Validation input must be a bounded JSON file.");
  const result = await checkExtension(
    JSON.parse(await readFile(inputPath, "utf8")) as unknown,
    {
      project: flags.includes("--project"),
      target,
      printIntegrity: flags.includes("--print-integrity"),
    },
  );
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.supported) process.exitCode = 1;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error: unknown) => {
    process.stderr.write(
      (error instanceof Error ? error.message : "Extension validation failed") +
        "\n",
    );
    process.exitCode = 1;
  });
