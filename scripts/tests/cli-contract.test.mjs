import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
    ["inspect", "validate", "status", "review", "feedback", "version", "update"],
  ],
]);

test("production build exposes every documented command", () => {
  const api = fs.readFileSync(path.join(scriptsDirectory, "API.d.ts"), "utf8");

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
  assert.match(api, /"azure-devops"\s*\|\s*"github"\s*\|\s*"url"\s*\|\s*"local"/);
  assert.doesNotMatch(api, /SpecificationSourceKind[^;]*\|\s*string/);
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
  assert.match(commandText.get("feedback"), /thread reply-batch --input -/);
  assert.match(
    commandText.get("feedback"),
    /one restack[\s\S]*<earliest-changed-stage-id>/,
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
  assert.match(commandText.get("help"), /installed `SKILL\.md` index/);
  assert.match(commandText.get("help"), /Do not return a\s+prewritten description/);
  assert.match(commandText.get("update"), /beside the target repository/);
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
  assert.match(viewerApp, /stage\.nodes\.every\(\(node\) => nodeApprovalState\(stage, node\) === "approved"\)/);
  assert.match(viewerApp, /delete state\.approvals\[stage\.id\]/);
  assert.match(viewerApp, /Approve every step before approving the stage/);
  assert.match(viewerApp, /if \(stage && !stageNodesApproved\(stage\)\) return;/);
  assert.match(ignore, /^\*:Zone\.Identifier$/m);
  assert.equal(packageJson.engines.node, ">=20");
  assert.doesNotMatch(scriptsReadme, /\.\\scripts|skills\\semantic-flow/);
  assert.doesNotMatch(repairSkill, /\.\\scripts|<source-repository>\\skills/);
  assert.match(userManual, /<semantic-implementation> <command>/);
  assert.match(userManual, /docs\/os\/linux\.md/);
  assert.match(userManual, /docs\/os\/windows\.md/);
});
