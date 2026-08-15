import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  feedbackCli,
  scriptsDirectory,
  semanticCli,
} from "./helpers/repository.mjs";

const commands = new Map([
  [
    semanticCli,
    [
      "init",
      "requirement add",
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
      "prepare-stack",
      "prepare-branch",
      "archive",
      "validate",
    ],
  ],
  [
    feedbackCli,
    [
      "init",
      "batch create",
      "batch delete",
      "comment add",
      "comment edit",
      "comment delete",
      "comment assign",
      "batch submit",
      "next",
      "comment resolve",
      "resolution rebind",
      "comment approve",
      "batch approve-all",
      "approve-stack",
      "validate",
    ],
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
});

test("skill routes OS invocation details without duplicating the workflow", () => {
  const skillRoot = path.resolve(scriptsDirectory, "..");
  const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  const steps = fs.readFileSync(
    path.join(skillRoot, "docs", "Steps.md"),
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

  assert.match(skill, /node -p "process\.platform"/);
  assert.match(skill, /`linux`: read `docs\/os\/linux\.md`/);
  assert.match(skill, /`win32` \(Windows\): read `docs\/os\/windows\.md`/);
  assert.match(skill, /Do not load the guide for the other operating system/);
  assert.match(steps, /<semantic-review> validate/);
  assert.match(steps, /<review-feedback> next --json/);
  assert.doesNotMatch(steps, /<skill-root>/);
  assert.match(linux, /<semantic-review>\s+=> node "\$semantic_review"/);
  assert.match(windows, /<semantic-review>\s+=> node \$semanticReview/);

  for (const platformGuide of [linux, windows]) {
    assert.match(platformGuide, /semantic-review\.mjs/);
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

  assert.match(attributes, /^\* text=auto eol=lf$/m);
  assert.match(editorConfig, /^end_of_line = lf$/m);
  assert.match(editorConfig, /^charset = utf-8$/m);
  assert.match(ignore, /^\*:Zone\.Identifier$/m);
  assert.equal(packageJson.engines.node, ">=20");
  assert.doesNotMatch(scriptsReadme, /\.\\scripts|skills\\semantic-flow/);
  assert.doesNotMatch(repairSkill, /\.\\scripts|<source-repository>\\skills/);
  assert.match(userManual, /<semantic-review> <command>/);
  assert.match(userManual, /docs\/os\/linux\.md/);
  assert.match(userManual, /docs\/os\/windows\.md/);
});
