import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { compileApiDefinition } from "./api-contract-check.js";
import { cliApis } from "./command-api.js";

const scriptsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(scriptsRoot, "..");
const skillRoot = path.join(repositoryRoot, "skills", "semantic-flow");
const outputDirectory = path.join(skillRoot, "scripts");
const referencesDirectory = path.join(skillRoot, "references");
const viewerSource = path.join(repositoryRoot, "viewer");
const viewerDestination = path.join(skillRoot, "viewer");
const packageManifest: unknown = JSON.parse(
  fs.readFileSync(path.join(scriptsRoot, "package.json"), "utf8"),
);

if (
  typeof packageManifest !== "object" ||
  packageManifest === null ||
  !("version" in packageManifest) ||
  typeof packageManifest.version !== "string"
) {
  throw new Error("scripts/package.json must declare a string version.");
}

fs.writeFileSync(
  path.join(skillRoot, "VERSION"),
  `${packageManifest.version}\n`,
  "utf8",
);

fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory, { recursive: true });

await build({
  entryPoints: {
    "semantic-implementation": path.join(
      scriptsRoot,
      "src",
      "semantic-implementation.ts",
    ),
    "review-feedback": path.join(scriptsRoot, "src", "review-feedback.ts"),
    "semantic-view": path.join(scriptsRoot, "src", "semantic-view.ts"),
    "semantic-flow": path.join(scriptsRoot, "src", "semantic-flow.ts"),
  },
  outdir: outputDirectory,
  outExtension: { ".js": ".mjs" },
  entryNames: "[name]",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  minify: true,
  legalComments: "none",
  sourcemap: false,
  logLevel: "info",
});

for (const file of [
  "semantic-implementation.mjs",
  "review-feedback.mjs",
  "semantic-view.mjs",
  "semantic-flow.mjs",
]) {
  fs.chmodSync(path.join(outputDirectory, file), 0o644);
}

fs.writeFileSync(
  path.join(outputDirectory, "API.d.ts"),
  compileApiDefinition(path.join(scriptsRoot, "src", "api.ts"), cliApis),
  "utf8",
);

const generatedReferences = [
  {
    source: path.join(repositoryRoot, "standard", "v0.1", "schema"),
    destination: path.join(referencesDirectory, "schema"),
  },
  {
    source: path.join(repositoryRoot, "standard", "v0.1", "feedback-schema"),
    destination: path.join(referencesDirectory, "feedback-schema"),
  },
];

for (const { source, destination } of generatedReferences) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

fs.mkdirSync(referencesDirectory, { recursive: true });
fs.copyFileSync(
  path.join(scriptsRoot, "schemas", "work-stage.schema.json"),
  path.join(referencesDirectory, "work-stage.schema.json"),
);
fs.copyFileSync(
  path.join(scriptsRoot, "schemas", "stage-organization.schema.json"),
  path.join(referencesDirectory, "stage-organization.schema.json"),
);

fs.rmSync(viewerDestination, { recursive: true, force: true });
fs.mkdirSync(viewerDestination, { recursive: true });
for (const file of ["index.html", "app.js", "styles.css", "favicon.svg"]) {
  fs.copyFileSync(
    path.join(viewerSource, file),
    path.join(viewerDestination, file),
  );
}

console.log(`Compiled semantic-flow skill at ${skillRoot}.`);
