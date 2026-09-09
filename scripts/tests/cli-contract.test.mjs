import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  feedbackCli,
  flowCli,
  scriptsDirectory,
  semanticCli,
} from "./helpers/repository.mjs";

const commands = new Map([
  [
    semanticCli,
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
      "stage finish",
      "stage discard",
      "restack",
      "repair",
      "publish",
      "validate-stack",
      "prepare-branch",
      "archive",
      "validate",
    ],
  ],
  [
    feedbackCli,
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
    flowCli,
    ["inspect", "validate", "prepare", "archive", "status", "review", "feedback", "sync", "version", "update"],
  ],
]);

test("production build exposes every documented command", () => {
  const api = fs.readFileSync(path.join(scriptsDirectory, "API.full.d.ts"), "utf8");

  for (const [cli, expectedCommands] of commands) {
    assert.ok(fs.statSync(cli).size > 0);
    assert.equal(fs.statSync(cli).mode & 0o111, 0);
    const help = execFileSync(process.execPath, [cli, "help"], {
      encoding: "utf8",
    });
    assert.match(help, /scripts\/API\.d\.ts/);
    for (const command of expectedCommands) {
      assert.match(help, new RegExp(`  \\S+ ${command.replace(" ", "\\s+")}`));
      assert.match(api, new RegExp(`@command ${command.replace(" ", "\\s+")}`));
    }

    const flagHelp = execFileSync(process.execPath, [cli, "--help"], {
      encoding: "utf8",
    });
    assert.equal(flagHelp, help);
  }

  assert.equal(fs.existsSync(path.join(scriptsDirectory, "API.md")), false);
  assert.match(api, /SpecificationSourceKind = string/);
});

test("command parsing rejects unknown commands, options, and malformed flags", () => {
  for (const cli of commands.keys()) {
    const unknownCommand = spawnSync(process.execPath, [cli, "unknown"], {
      encoding: "utf8",
    });
    assert.notEqual(unknownCommand.status, 0);
    assert.match(unknownCommand.stderr, /Unknown command/);

    const unknownOption = spawnSync(
      process.execPath,
      [cli, "validate", "--unknown"],
      { encoding: "utf8" },
    );
    assert.notEqual(unknownOption.status, 0);
    assert.match(unknownOption.stderr, /Unknown option --unknown/);
  }

  const valuedHelp = spawnSync(
    process.execPath,
    [semanticCli, "validate", "--help=true"],
    { encoding: "utf8" },
  );
  assert.notEqual(valuedHelp.status, 0);
  assert.match(valuedHelp.stderr, /--help is a flag and does not take a value/);

  const topLevelValuedHelp = spawnSync(
    process.execPath,
    [semanticCli, "--help=true"],
    { encoding: "utf8" },
  );
  assert.notEqual(topLevelValuedHelp.status, 0);
  assert.match(
    topLevelValuedHelp.stderr,
    /--help is a flag and does not take a value/,
  );
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

test("the bundled example conforms to the published schemas", (t) => {
  const repositoryRoot = path.resolve(scriptsDirectory, "..", "..", "..");
  const example = path.join(
    repositoryRoot,
    "examples",
    "order-cancellation",
    ".semantic-review",
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-example-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(example, path.join(root, ".semantic-review"), { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });

  const result = spawnSync(
    process.execPath,
    [semanticCli, "validate", "--schema-only"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /schema validation passed/);
});

test("skill indexes command-specific workflows", () => {
  const skillRoot = path.resolve(scriptsDirectory, "..");
  const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  const runtime = fs.readFileSync(
    path.join(skillRoot, "docs", "runtime.md"),
    "utf8",
  );
  const linux = fs.readFileSync(
    path.join(skillRoot, "docs", "os", "linux.md"),
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
  assert.match(runtime, /<semantic-flow> inspect --json/);
  assert.match(runtime, /otherwise the only\s+matching artifact/);
  assert.match(commandText.get("implement"), /<semantic-implementation> stage begin/);
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
    /This is not an\s+interrupted artifact write[\s\S]*Do not run `repair`/,
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
  assert.match(linux, /<semantic-implementation>\s+=> node "\$semantic_implementation"/);
  assert.match(windows, /<semantic-implementation>\s+=> node \$semanticImplementation/);

  for (const platformGuide of [linux, windows]) {
    assert.match(platformGuide, /semantic-flow\.mjs/);
    assert.match(platformGuide, /semantic-implementation\.mjs/);
    assert.match(platformGuide, /review-feedback\.mjs/);
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
  assert.match(guide, /`os\/windows\.md`[\s\S]*`os\/linux\.md`/);
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

test("repository metadata and maintainer guidance preserve portability", () => {
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
  const repairSkill = fs.readFileSync(
    path.join(repositoryRoot, "skills", "semantic-flow-repair", "SKILL.md"),
    "utf8",
  );
  const userManual = fs.readFileSync(
    path.join(repositoryRoot, "docs", "user-manual.md"),
    "utf8",
  );
  const viewerApp = fs.readFileSync(
    path.join(repositoryRoot, "viewer", "app.js"),
    "utf8",
  );

  assert.match(attributes, /^\* text=auto eol=lf$/m);
  assert.match(editorConfig, /^end_of_line = lf$/m);
  assert.match(editorConfig, /^charset = utf-8$/m);
  assert.match(viewerApp, /t\.anchorStale/);
  assert.match(viewerApp, /root\.style\.scrollBehavior = "auto"/);
  assert.doesNotMatch(viewerApp, /approveBtn\("node"/);
  assert.match(viewerApp, /nodeApprovalState\(stage, node\)/);
  assert.match(viewerApp, /data-node-id="\$\{node\.id\}"/);
  assert.match(viewerApp, /toggleCinema\(btn\.dataset\.id, btn\.dataset\.nodeId\)/);
  assert.match(viewerApp, /const focusNodeId = activeFileNodeId\(fid\)/);
  const selectedNodeStart = viewerApp.indexOf("function selectedNodeForFile(activeValue, file)");
  const selectedNodeEnd = viewerApp.indexOf("\n  function activeFileNodeId", selectedNodeStart);
  assert.notEqual(selectedNodeStart, -1);
  assert.notEqual(selectedNodeEnd, -1);
  const selectedNodeForFile = new Function(
    `${viewerApp.slice(selectedNodeStart, selectedNodeEnd)}; return selectedNodeForFile;`,
  )();
  const sharedFile = {
    memberships: [{ nodeId: "first-node" }, { nodeId: "clicked-node" }],
  };
  assert.equal(selectedNodeForFile("clicked-node", sharedFile), "clicked-node");
  assert.equal(selectedNodeForFile(true, sharedFile), "first-node");
  assert.equal(selectedNodeForFile(false, sharedFile), null);
  const aggregateStart = viewerApp.indexOf("function aggregateApprovalState(states)");
  const aggregateEnd = viewerApp.indexOf("\n  function nodeApprovalState", aggregateStart);
  assert.notEqual(aggregateStart, -1);
  assert.notEqual(aggregateEnd, -1);
  const aggregateApprovalState = new Function(
    `${viewerApp.slice(aggregateStart, aggregateEnd)}; return aggregateApprovalState;`,
  )();
  assert.equal(aggregateApprovalState([]), "none");
  assert.equal(aggregateApprovalState(["none", "approved"]), "none");
  assert.equal(aggregateApprovalState(["approved", "approved"]), "approved");
  assert.equal(aggregateApprovalState(["stale", "stale"]), "stale");
  assert.equal(aggregateApprovalState(["approved", "stale"]), "stale");
  const formatterStart = viewerApp.indexOf("function esc(v)");
  const formatterEnd = viewerApp.indexOf("\n  /* File approvals", formatterStart);
  assert.notEqual(formatterStart, -1);
  assert.notEqual(formatterEnd, -1);
  const formatCommentBody = new Function(
    `${viewerApp.slice(formatterStart, formatterEnd)}; return formatCommentBody;`,
  )();
  assert.equal(
    formatCommentBody("First line\n\nUse `my code`."),
    "First line\n\nUse <code>my code</code>.",
  );
  assert.equal(
    formatCommentBody("<script>\n`<b>`"),
    "&lt;script&gt;\n<code>&lt;b&gt;</code>",
  );
  assert.match(viewerApp, /stage\.nodes\.every\(\(node\) => nodeApprovalState\(stage, node\) === "approved"\)/);
  assert.match(viewerApp, /delete state\.approvals\[stage\.id\]/);
  assert.match(viewerApp, /Approve every step before approving the stage/);
  assert.match(viewerApp, /if \(stage && !stageNodesApproved\(stage\)\) return;/);
  assert.match(viewerApp, /Stage approval pending/);
  assert.match(ignore, /^\*:Zone\.Identifier$/m);
  assert.equal(packageJson.engines.node, ">=20");
  assert.doesNotMatch(scriptsReadme, /\.\\scripts|skills\\semantic-flow/);
  assert.doesNotMatch(repairSkill, /\.\\scripts|<source-repository>\\skills/);
  assert.match(userManual, /<semantic-implementation> <command>/);
  assert.match(userManual, /docs\/os\/linux\.md/);
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
