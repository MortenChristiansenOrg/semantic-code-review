import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  createImplementationWithStages,
  flowCli,
  scriptsDirectory,
  semanticCli,
} from "./helpers/repository.mjs";
import {
  MANIFEST_SCHEMA_ID,
  SPECIFICATION_SCHEMA_ID,
  STAGE_SCHEMA_ID,
} from "../src/shared/documents.ts";
import { MINIMUM_NODE_MAJOR } from "../src/shared/distribution.ts";
import { stageBranchName } from "../src/shared/implementation.ts";
import { readDocument } from "../src/shared/schema-validation.ts";

// Each command group runs inside the one executable; the key is the group
// prefix typed after it ("" for the workflow commands).
const groupArgs = (group) => group ? [flowCli, group] : [flowCli];
const commands = new Map([
  [
    "implementation",
    [
      "init",
      "specification add",
      "stage begin",
      "stage set",
      "stage record",
      "stage record-batch",
      "stage plan",
      "stage organize",
      "stage validation",
      "stage evidence",
      "stage evidence-remove",
      "stage no-evidence",
      "stage finish",
      "stage discard",
      "restack",
      "publish",
      "export",
      "validate-stack",
      "prepare-branch",
      "archive",
      "validate",
    ],
  ],
  [
    "feedback",
    [
      "init",
      "thread add",
      "thread add-batch",
      "next",
      "thread reply",
      "thread reply-batch",
      "thread resolve",
      "thread reopen",
      "validate",
    ],
  ],
  [
    "",
    ["inspect", "validate", "prepare", "archive", "status", "review", "feedback", "sync", "refresh-target", "version", "update"],
  ],
]);

test("production build exposes every documented command", () => {
  const api = fs.readFileSync(path.join(scriptsDirectory, "API.full.d.ts"), "utf8");

  assert.ok(fs.statSync(flowCli).size > 0);
  assert.equal(fs.statSync(flowCli).mode & 0o111, 0);
  assert.deepEqual(
    fs.readdirSync(scriptsDirectory).filter((file) => file.endsWith(".mjs")),
    ["semantic-flow.mjs"],
  );
  for (const [group, expectedCommands] of commands) {
    const help = execFileSync(process.execPath, [...groupArgs(group), "help"], {
      encoding: "utf8",
    });
    assert.match(help, /scripts\/API\.d\.ts/);
    for (const command of expectedCommands) {
      const typed = `${group ? `${group} ` : ""}${command}`.replaceAll(" ", "\\s+");
      assert.match(help, new RegExp(`  semantic-flow\\.mjs ${typed}`));
      assert.match(api, new RegExp(`@cli semantic-flow\\.mjs\\n \\* @command ${typed}$`, "m"));
    }

    const flagHelp = execFileSync(process.execPath, [...groupArgs(group), "--help"], {
      encoding: "utf8",
    });
    assert.equal(flagHelp, help);
  }
  const workflowHelp = execFileSync(process.execPath, [flowCli, "help"], { encoding: "utf8" });
  for (const group of ["implementation", "feedback"]) {
    assert.match(workflowHelp, new RegExp(`  semantic-flow\\.mjs ${group} <command> \\[options\\]`));
  }

  assert.equal(fs.existsSync(path.join(scriptsDirectory, "API.md")), false);
  assert.match(api, /SpecificationSourceKind = string/);
});

test("command parsing rejects unknown commands, options, and malformed flags", () => {
  for (const group of commands.keys()) {
    const unknownCommand = spawnSync(process.execPath, [...groupArgs(group), "unknown"], {
      encoding: "utf8",
    });
    assert.notEqual(unknownCommand.status, 0);
    assert.match(unknownCommand.stderr, /Unknown command/);

    const unknownOption = spawnSync(
      process.execPath,
      [...groupArgs(group), "validate", "--unknown"],
      { encoding: "utf8" },
    );
    assert.notEqual(unknownOption.status, 0);
    assert.match(unknownOption.stderr, /Unknown option --unknown/);
  }

  const valuedHelp = spawnSync(
    process.execPath,
    [...semanticCli, "validate", "--help=true"],
    { encoding: "utf8" },
  );
  assert.notEqual(valuedHelp.status, 0);
  assert.match(valuedHelp.stderr, /--help is a flag and does not take a value/);

  const topLevelValuedHelp = spawnSync(
    process.execPath,
    [...semanticCli, "--help=true"],
    { encoding: "utf8" },
  );
  assert.notEqual(topLevelValuedHelp.status, 0);
  assert.match(
    topLevelValuedHelp.stderr,
    /--help is a flag and does not take a value/,
  );

  const viewerWithoutCommand = spawnSync(process.execPath, [flowCli, "viewer"], { encoding: "utf8" });
  assert.notEqual(viewerWithoutCommand.status, 0);
  assert.match(viewerWithoutCommand.stderr, /usage: semantic-flow viewer serve/);
  const viewerUnknownOption = spawnSync(process.execPath, [flowCli, "viewer", "serve", "--unknown"], { encoding: "utf8" });
  assert.notEqual(viewerUnknownOption.status, 0);
  assert.match(viewerUnknownOption.stderr, /Unknown option --unknown/);
});

test("feedback selects its group by a command, wherever the options stand", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  repository.feedback("thread", "add", "--id", "routing", "--comment-id", "routing-comment", "--body", "Check the routing.",
    "--label", "Implementation", "--target-kind", "stage", "--stage", "implementation");
  const run = (args, input) => spawnSync(process.execPath, [flowCli, ...args], { cwd: repository.root, input, encoding: "utf8" });
  const commandFirst = run(["feedback", "next", "--input", "-"], '{"json": true}');
  assert.equal(commandFirst.status, 0, commandFirst.stderr);
  const optionsFirst = run(["feedback", "--input", "-", "next"], '{"json": true}');
  assert.equal(optionsFirst.status, 0, optionsFirst.stderr);
  assert.deepEqual(JSON.parse(optionsFirst.stdout), JSON.parse(commandFirst.stdout));
  assert.equal(JSON.parse(optionsFirst.stdout)[0].threads[0].id, "routing");

  // Without a command, feedback is the workflow command that collects pending feedback.
  const workflow = run(["feedback", "--json"]);
  assert.equal(workflow.status, 0, workflow.stderr);
  assert.equal(JSON.parse(workflow.stdout).stages[0].threads[0].id, "routing");
  const listening = run(["feedback", "--wait", "--json", "--session", "unknown-session", "--timeout", "1"]);
  assert.equal(listening.status, 0, listening.stderr);
  assert.deepEqual(JSON.parse(listening.stdout), { session: "unknown-session", stopped: true, reason: "superseded" });
});

test("CLI subprocess launches hide Windows console windows", () => {
  const sourceRoot = path.resolve(scriptsDirectory, "..", "..", "..", "scripts", "src");
  const failures = [];
  let launches = 0;
  for (const file of ts.sys.readDirectory(sourceRoot, [".ts"])) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const processCalls = new Set();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) ||
          statement.moduleSpecifier.text !== "node:child_process") continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const binding of bindings.elements) {
        const name = (binding.propertyName ?? binding.name).text;
        if (["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"].includes(name)) {
          processCalls.add(binding.name.text);
        }
      }
    }
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
          processCalls.has(node.expression.text)) {
        launches += 1;
        const options = node.arguments.find(ts.isObjectLiteralExpression);
        const hidesWindow = options?.properties.some((property) =>
          ts.isPropertyAssignment(property) &&
          property.name.getText(source) === "windowsHide" &&
          property.initializer.kind === ts.SyntaxKind.TrueKeyword);
        if (!hidesWindow) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          failures.push(`${path.relative(sourceRoot, file)}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(launches > 0, "No subprocess launches found");
  assert.deepEqual(failures, [], "Subprocess launches must set windowsHide: true");
});

test("the bundled example conforms to the published schemas", () => {
  // The example is a published artifact: the full form, in which each stage
  // records the change the active artifact derives from Git.
  const repositoryRoot = path.resolve(scriptsDirectory, "..", "..", "..");
  const example = path.join(repositoryRoot, "examples", "order-cancellation", ".semantic-review");
  const document = (file) => path.join(example, file);
  const manifest = readDocument(MANIFEST_SCHEMA_ID, document("manifest.json"));
  for (const id of manifest.requirements) {
    assert.equal(readDocument(SPECIFICATION_SCHEMA_ID, document(`requirements/${id}.json`)).id, id);
  }
  let baseBranch = manifest.targetBranch, baseRevision = manifest.baseRevision;
  for (const id of manifest.stages) {
    const stage = readDocument(STAGE_SCHEMA_ID, document(`stages/${id}.json`));
    assert.equal(stage.id, id);
    assert.equal(stage.change.branch, stageBranchName(manifest.branchPrefix, id));
    assert.equal(stage.change.baseBranch, baseBranch);
    assert.equal(stage.change.baseRevision, baseRevision);
    ({ branch: baseBranch, headRevision: baseRevision } = stage.change);
  }
  assert.deepEqual(
    fs.readdirSync(document("stages")).sort(),
    manifest.stages.map((id) => `${id}.json`).sort(),
  );
});

test("skill indexes command-specific workflows", () => {
  const skillRoot = path.resolve(scriptsDirectory, "..");
  const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  const runtime = fs.readFileSync(
    path.join(skillRoot, "docs", "runtime.md"),
    "utf8",
  );
  const unix = fs.readFileSync(
    path.join(skillRoot, "docs", "os", "unix.md"),
    "utf8",
  );
  const windows = fs.readFileSync(
    path.join(skillRoot, "docs", "os", "windows.md"),
    "utf8",
  );
  const readme = fs.readFileSync(
    path.resolve(skillRoot, "..", "..", "README.md"),
    "utf8",
  );

  const commands = [
    "implicit",
    "report",
    "implement",
    "review",
    "feedback",
    "reconcile",
    "simulate",
    "status",
    "continue",
    "sync",
    "validate",
    "prepare",
    "archive",
    "version",
    "update",
    "help",
  ];
  const commandText = new Map(
    commands.map((command) => [
      command,
      fs.readFileSync(
        path.join(skillRoot, "commands", `${command}.md`),
        "utf8",
      ),
    ]),
  );

  for (const command of commands) {
    assert.match(skill, new RegExp(`commands/${command}\\.md`));
  }
  assert.doesNotMatch(skill, /node -p "process\.platform"/);
  assert.doesNotMatch(skill, /git worktree list --porcelain/);
  assert.match(runtime, /node -p "process\.platform"/);
  // Every operating system CI tests has a guide, so the skill does not stop there.
  const checks = fs.readFileSync(path.resolve(skillRoot, "..", "..", ".github", "workflows", "checks.yml"), "utf8");
  const platforms = { ubuntu: "linux", macos: "darwin", windows: "win32" };
  const tested = [...checks.matchAll(/\b(ubuntu|macos|windows)-latest\b/g)].map((match) => platforms[match[1]]);
  assert.deepEqual([...new Set(tested)].sort(), ["darwin", "linux", "win32"]);
  for (const platform of tested) {
    const [, guide] = runtime.match(new RegExp(`^\\s*- [^\\n]*\`${platform}\`[^\\n]*: \`(os/[a-z]+\\.md)\``, "m")) ?? [];
    assert.ok(guide && fs.existsSync(path.join(skillRoot, "docs", guide)), `runtime.md names no guide for ${platform}`);
  }
  assert.match(runtime, /<semantic-flow> inspect --json/);
  assert.match(runtime, /otherwise the only\s+matching one/);
  assert.match(commandText.get("implement"), /<semantic-flow> implementation stage begin/);
  assert.match(commandText.get("feedback"), /<semantic-flow> feedback --json/);
  assert.match(
    commandText.get("feedback"),
    /automatically\s+restacks[\s\S]*Never ask the user to approve it/,
  );
  assert.match(commandText.get("feedback"), /thread marked `restacked: true`/);
  assert.match(commandText.get("feedback"), /thread reply-batch --input -/);
  assert.match(
    commandText.get("feedback"),
    /one restack[\s\S]*<earliest-changed-stage-id>/,
  );
  assert.match(
    commandText.get("feedback"),
    /Do not ask for permission\s+merely because Git reported a conflict/,
  );
  assert.match(
    fs.readFileSync(path.join(skillRoot, "docs", "restack-conflicts.md"), "utf8"),
    /git update-ref refs\/heads\/<stage-branch> <resolution-head> <reported-stage-head>/,
  );
  assert.doesNotMatch(commandText.get("feedback"), /Read `\.\.\/docs\/runtime\.md`/);
  assert.match(commandText.get("reconcile"), /temporary recovery branch/);
  assert.match(
    commandText.get("reconcile"),
    /restack --from <earliest-changed-stage-id>/,
  );
  assert.match(
    commandText.get("reconcile"),
    /Do not restack after each stage/,
  );
  assert.match(
    commandText.get("reconcile"),
    /git branch --delete --force <temporary-recovery-branch>/,
  );
  assert.match(
    commandText.get("reconcile"),
    /successful reconciliation is incomplete while that ref remains/,
  );
  assert.match(
    commandText.get("simulate"),
    /\.semantic-review\/manifest\.json/,
  );
  assert.match(commandText.get("simulate"), /temporary simulation snapshot/);
  assert.match(
    commandText.get("simulate"),
    /source branch and source commit are unchanged/,
  );
  assert.match(
    commandText.get("simulate"),
    /Do not invent historical decisions/,
  );
  assert.match(
    commandText.get("simulate"),
    /successful simulation is incomplete while that ref remains/,
  );
  assert.match(skill, /\| `\/semantic-flow simulate` \| `sim` \|/);
  assert.match(readme, /\| `simulate` or `sim` \|/);
  assert.match(commandText.get("review"), /<semantic-flow> review/);
  assert.doesNotMatch(commandText.get("review"), /Read `\.\.\/docs\/runtime\.md`/);
  assert.match(commandText.get("validate"), /<semantic-flow> validate/);
  assert.match(commandText.get("status"), /<semantic-flow> status/);
  assert.match(commandText.get("version"), /<semantic-flow> version/);
  assert.match(commandText.get("update"), /<semantic-flow> update/);
  assert.match(commandText.get("update"), /waits for the process to exit/);
  assert.match(commandText.get("update"), /same URL without\s+opening another browser tab/);
  assert.match(commandText.get("update"), /Do not stop the launcher shell/);
  assert.match(commandText.get("help"), /installed `SKILL\.md` index/);
  assert.match(commandText.get("help"), /Do not return a\s+prewritten description/);
  assert.match(commandText.get("update"), /latest published release/);
  const sourceScriptsRoot = path.resolve(skillRoot, "..", "..", "scripts");
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(sourceScriptsRoot, "package.json"), "utf8"),
  );
  assert.equal(
    fs.readFileSync(path.join(skillRoot, "VERSION"), "utf8").trim(),
    packageJson.version,
  );
  assert.match(unix, /<semantic-flow>\s+=> node "\$semantic_flow"/);
  assert.match(windows, /<semantic-flow>\s+=> node \$semanticFlow/);

  // One executable and one placeholder; command groups follow it.
  const skillFiles = fs.readdirSync(skillRoot, { recursive: true })
    .filter((file) => file.endsWith(".md") && !file.startsWith("scripts"))
    .map((file) => [file, fs.readFileSync(path.join(skillRoot, file), "utf8")]);
  for (const [file, text] of skillFiles) {
    assert.doesNotMatch(text, /<(semantic-implementation|review-feedback|semantic-view)>/, file);
    assert.doesNotMatch(text, /(semantic-implementation|review-feedback|semantic-view)\.mjs/, file);
  }
  assert.match(unix, /node "\$semantic_flow" implementation validate/);
  assert.match(unix, /node "\$semantic_flow" feedback next --json/);
  assert.match(windows, /node \$semanticFlow implementation validate/);
  assert.match(windows, /node \$semanticFlow feedback next --json/);
  for (const platformGuide of [unix, windows]) {
    assert.match(platformGuide, /semantic-flow\.mjs/);
    assert.doesNotMatch(platformGuide, /## [1-7]\./);
  }
});

test("finalized reorganization guidance supplies the complete CLI input", () => {
  const skillRoot = path.resolve(scriptsDirectory, "..");
  const guidePath = "../docs/finalized-stage-organization.md";
  for (const command of ["feedback", "reconcile"]) {
    const commandFile = path.join(skillRoot, "commands", `${command}.md`);
    const text = fs.readFileSync(commandFile, "utf8");
    assert.ok(text.includes(guidePath));
    assert.doesNotMatch(text, /`stage organize --finalized`/);
    assert.ok(fs.existsSync(path.resolve(path.dirname(commandFile), guidePath)));
  }

  const guide = fs.readFileSync(
    path.join(skillRoot, "docs", "finalized-stage-organization.md"),
    "utf8",
  );
  assert.match(guide, /stage plan --finalized --stage <stage-id>/);
  assert.match(
    guide,
    /stage organize --finalized --stage <stage-id> --file <organization-json>/,
  );
  assert.match(guide, /\.\.\/references\/stage-organization\.schema\.json/);
  assert.match(guide, /`os\/windows\.md`[\s\S]*`os\/unix\.md`/);
  assert.match(guide, /complete stage diff, not just the latest correction commit/);
  assert.match(guide, /`nodes`: the complete replacement node list/);
  assert.match(guide, /`itemLinks`: one entry for every recorded insight and validation item/);
  assert.match(guide, /not the manifest or an existing stage artifact/);
  assert.match(guide, /`--input` does not replace `--file`/);
  assert.match(guide, /deletion relative to the\s+stage base is still a change/);
  assert.match(guide, /do not restack after\s+each organization/);

  const feedback = fs.readFileSync(
    path.join(skillRoot, "commands", "feedback.md"),
    "utf8",
  );
  assert.match(feedback, /read the relevant installed API module and command\s+help/);
  assert.match(feedback, /No\s+extra user approval is needed/);
  assert.match(feedback, /missing argument is not evidence of an artifact migration problem/);
});

test("repository metadata and maintainer guidance preserve portability", async () => {
  const skillRoot = path.resolve(scriptsDirectory, "..");
  const repositoryRoot = path.resolve(skillRoot, "..", "..");
  const attributes = fs.readFileSync(
    path.join(repositoryRoot, ".gitattributes"),
    "utf8",
  );
  const editorConfig = fs.readFileSync(
    path.join(repositoryRoot, ".editorconfig"),
    "utf8",
  );
  const ignore = fs.readFileSync(
    path.join(repositoryRoot, ".gitignore"),
    "utf8",
  );
  const packageJson = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, "scripts", "package.json"),
      "utf8",
    ),
  );
  const scriptsReadme = fs.readFileSync(
    path.join(repositoryRoot, "scripts", "README.md"),
    "utf8",
  );
  const sourceRepair = fs.readFileSync(
    path.join(repositoryRoot, "skills", "semantic-flow", "references", "report", "source-repair.md"),
    "utf8",
  );
  const userManual = fs.readFileSync(
    path.join(repositoryRoot, "docs", "user-manual.md"),
    "utf8",
  );
  // The page's modules: everything bundled into app.js except its request module.
  const viewerSources = path.join(repositoryRoot, "viewer", "src");
  const viewerApp = fs.readdirSync(viewerSources, { recursive: true })
    .map((name) => String(name).replaceAll("\\", "/"))
    .filter((name) => name.endsWith(".ts") && name !== "api.ts" && name !== "markdown.ts")
    .sort().map((name) => fs.readFileSync(path.join(viewerSources, name), "utf8")).join("\n");
  const { selectedNodeForFile } = await import("../../viewer/src/files.ts");
  const { aggregateApprovalState } = await import("../../viewer/src/approvals.ts");

  assert.match(attributes, /^\* text=auto eol=lf$/m);
  assert.match(editorConfig, /^end_of_line = lf$/m);
  assert.match(editorConfig, /^charset = utf-8$/m);
  assert.match(viewerApp, /t\.anchorStale/);
  assert.doesNotMatch(viewerApp, /approveBtn\("node"/);
  assert.match(viewerApp, /nodeApprovalState\(stage, node\)/);
  assert.match(viewerApp, /toggleCinema\(btn\.dataset\.id, btn\.dataset\.nodeId\)/);
  const sharedFile = {
    memberships: [{ nodeId: "first-node" }, { nodeId: "clicked-node" }],
  };
  assert.equal(selectedNodeForFile("clicked-node", sharedFile), "clicked-node");
  assert.equal(selectedNodeForFile(true, sharedFile), null);
  assert.equal(selectedNodeForFile("removed-node", sharedFile), null);
  assert.equal(selectedNodeForFile(false, sharedFile), null);
  assert.equal(aggregateApprovalState([]), "none");
  assert.equal(aggregateApprovalState(["none", "approved"]), "none");
  assert.equal(aggregateApprovalState(["approved", "approved"]), "approved");
  assert.equal(aggregateApprovalState(["stale", "stale"]), "stale");
  assert.equal(aggregateApprovalState(["approved", "stale"]), "stale");
  assert.match(viewerApp, /stage\.nodes\.every\(\(node\) => nodeApprovalState\(stage, node\) === "approved"\)/);
  assert.match(viewerApp, /delete state\.approvals\[stage\.id\]/);
  assert.match(viewerApp, /Approve every step before approving the stage/);
  assert.match(viewerApp, /if \(stage && !stageNodesApproved\(stage\)\) return;/);
  assert.match(ignore, /^\*:Zone\.Identifier$/m);
  assert.equal(packageJson.engines.node, ">=22");
  assert.doesNotMatch(scriptsReadme, /\.\\scripts|skills\\semantic-flow/);
  assert.doesNotMatch(sourceRepair, /\.\\scripts|<source-repository>\\skills/);
  assert.match(userManual, /<semantic-flow> implementation <command>/);
  assert.match(userManual, /<semantic-flow> feedback <command>/);
  assert.match(userManual, /docs\/os\/unix\.md/);
  assert.match(userManual, /docs\/os\/windows\.md/);
});

test("implementation and continuation distinguish recoverable CLI errors from user decisions", () => {
  const root = path.resolve(scriptsDirectory, "..");
  const runtime = fs.readFileSync(path.join(root, "docs/runtime.md"), "utf8");
  for (const command of ["implement", "continue"]) {
    const guide = fs.readFileSync(path.join(root, `commands/${command}.md`), "utf8");
    assert.match(guide, /Unsupported insight kinds or decision categories/);
    assert.match(guide, /without asking for\s+approval/);
    assert.match(guide, /metadata recording failure does not pause/);
  }
  assert.match(runtime, /`architecture` fails/);
  assert.match(runtime, /`engineering`/);
  assert.match(runtime, /inspect current state before retrying/);
  assert.match(runtime, /genuine product or design ambiguity, conflicting/);
});

/** Where a source breaks the typed JSON boundary: casts, assertions, `any`, or JSON.parse outside shared/json.ts. */
function typedBoundaryViolations(relative, text) {
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  const findings = [];
  const report = (node, reason) => findings.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${reason}`);
  const unwrap = (node) => ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  const memberName = (node) => ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
  // JSON itself or a qualified reference to it such as globalThis.JSON or window["JSON"].
  const isJson = (node) => {
    const expression = unwrap(node);
    return ts.isIdentifier(expression) ? expression.text === "JSON" : memberName(expression) === "JSON";
  };
  // Any reference to JSON's parse member, called or not, or destructured from JSON.
  const isJsonParse = (node) => (memberName(node) === "parse" && isJson(node.expression)) ||
    (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined && isJson(node.initializer) &&
      node.name.elements.some(({ propertyName, name }) => {
        const key = propertyName ?? name;
        return (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === "parse";
      }));
  const visit = (node) => {
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && !(ts.isTypeReferenceNode(node.type) && node.type.typeName.getText(source) === "const")) report(node, "type assertion");
    if (ts.isNonNullExpression(node)) report(node, "non-null assertion");
    if (node.kind === ts.SyntaxKind.AnyKeyword) report(node, "any type");
    if (isJsonParse(node) && relative !== "shared/json.ts") report(node, "JSON.parse outside shared/json.ts; use parseJson or readJson");
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

test("sources narrow values instead of casting, asserting, or parsing JSON outside the typed boundary", () => {
  const sourceRoot = path.join(scriptsDirectory, "..", "..", "..", "scripts", "src");
  const files = fs.readdirSync(sourceRoot, { recursive: true }).filter((file) => file.endsWith(".ts")).map((file) => path.join(sourceRoot, file));
  const findings = files.flatMap((file) =>
    typedBoundaryViolations(path.relative(sourceRoot, file).split(path.sep).join("/"), fs.readFileSync(file, "utf8")));
  assert.deepEqual(findings, []);
});

test("the typed boundary check finds JSON.parse however it is accessed", () => {
  const references = ["JSON.parse(text);", 'JSON["parse"](text);', "JSON['parse'](text);", "(JSON).parse(text);", "(JSON.parse)(text);", "JSON?.parse(text);",
    "globalThis.JSON.parse(text);", 'window["JSON"].parse(text);', "self.JSON?.parse(text);", "const parse = JSON.parse;", "lines.map(JSON.parse);",
    "const { parse } = JSON;", "const { parse: decode } = globalThis.JSON;", 'const { "parse": decode } = JSON;'];
  for (const reference of references) assert.equal(typedBoundaryViolations("example.ts", reference).length, 1, reference);
  assert.deepEqual(typedBoundaryViolations("shared/json.ts", 'JSON["parse"](text); const parse = globalThis.JSON.parse;'), []);
  assert.deepEqual(typedBoundaryViolations("example.ts",
    "parseJson(text); JSON.stringify(value); other.parse(text); const { stringify } = JSON; const { parse } = other; JSON.parsed;"), []);
});

test("the skill, package, build, CI, release and documentation state one Node.js minimum", () => {
  const skillRoot = path.resolve(scriptsDirectory, "..");
  const repositoryRoot = path.resolve(skillRoot, "..", "..");
  const read = (...parts) => fs.readFileSync(path.join(repositoryRoot, ...parts), "utf8");
  const minimum = MINIMUM_NODE_MAJOR;
  assert.equal(JSON.parse(read("scripts", "package.json")).engines.node, `>=${minimum}`);
  assert.match(read("scripts", "src", "build-skill.ts"), new RegExp(`target: "node${minimum}"`));
  // The minimum on every operating system, newer lines on Linux.
  const checks = read(".github", "workflows", "checks.yml");
  assert.match(checks, new RegExp(`os: \\[ubuntu-latest, windows-latest, macos-latest\\]\\s+node: \\[${minimum}\\]`));
  assert.match(checks, /node-version: \$\{\{ matrix\.node \}\}/);
  // Newer LTS lines run on Linux; at least one newer line is always supported.
  const newer = [...checks.matchAll(/- os: ubuntu-latest\s+node: (\d+)$/gm)].map((match) => Number(match[1]));
  assert.ok(newer.length > 0 && newer.every((node) => node > minimum && node % 2 === 0), String(newer));
  assert.deepEqual([...new Set([...read(".github", "workflows", "release.yml").matchAll(/node-version: (\S+)/g)].map((match) => match[1]))], [String(minimum)]);
  // The skill's preflight in every platform guide.
  const guides = fs.readdirSync(path.join(skillRoot, "docs", "os"));
  assert.ok(guides.length >= 2);
  for (const guide of guides) assert.match(read("skills", "semantic-flow", "docs", "os", guide), new RegExp(`Node\\.js is version ${minimum} or later`));
  assert.match(read("README.md"), new RegExp(`Node\\.js ${minimum} or newer is required`));
  assert.match(read("docs", "releases.md"), new RegExp(`Install Node\\.js ${minimum} or newer`));
});
