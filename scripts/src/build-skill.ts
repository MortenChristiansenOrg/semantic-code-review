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

fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory, { recursive: true });

await build({
  entryPoints: {
    "semantic-review": path.join(scriptsRoot, "src", "semantic-review.ts"),
    "review-feedback": path.join(scriptsRoot, "src", "review-feedback.ts"),
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

for (const file of ["semantic-review.mjs", "review-feedback.mjs"]) {
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

console.log(`Compiled semantic-flow skill at ${skillRoot}.`);
