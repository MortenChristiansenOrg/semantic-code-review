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
