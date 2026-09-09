#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { assetName, compareVersions, nextVersion, parseVersion, RELEASE_REPOSITORY } from "./shared/release-version.js";
import { sha256, skillFiles, unpackDistribution, type ReleaseMetadata } from "./shared/distribution.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestFile = path.join(root, "scripts/package.json");
const json = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, windowsHide: true, encoding: "utf8" }).trim();
const gh = (...args: string[]) => execFileSync("gh", args, { cwd: root, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function validateNotes(notes: string, version: string): void {
  if (!notes.startsWith(`# v${version} — `) || !/^# v\S+ — \d{4}-\d{2}-\d{2}\n/.test(notes)) throw new Error("Release notes need a matching version and YYYY-MM-DD date.");
  for (const heading of ["Overview", "Breaking changes", "Updating"]) {
    const section = notes.split(`## ${heading}\n`)[1]?.split(/\n## /)[0]?.trim();
    if (!section || /\b(TODO|TBD)\b|<[^>]+>/.test(section)) throw new Error(`Write the ${heading} section before releasing.`);
  }
  if (version.startsWith("0.") && !/experimental/i.test(notes)) throw new Error("0.x notes must explain experimental compatibility.");
}

export async function packageRelease(output: string): Promise<{ archive: string; checksum: string; version: string; sourceCommit: string }> {
  if (git("status", "--porcelain", "--untracked-files=normal")) throw new Error("Commit the release changes before packaging; the worktree must be clean.");
  const pkg = json(manifestFile), version = pkg.version;
  parseVersion(version);
  const sourceCommit = git("rev-parse", "HEAD");
  const skill = path.join(root, "skills/semantic-flow");
  if (fs.readFileSync(path.join(skill, "VERSION"), "utf8").trim() !== version) throw new Error("Build the skill after changing its version.");
  const lock = json(path.join(root, "scripts/package-lock.json"));
  if (lock.version !== version || lock.packages[""].version !== version) throw new Error("Package and lockfile versions differ.");
  validateNotes(fs.readFileSync(path.join(root, `releases/${version}.md`), "utf8"), version);
  const files = skillFiles(skill);
  if (files.includes("RELEASE.json")) throw new Error("Source skill contains stale release metadata; remove it and rebuild.");
  const metadata: ReleaseMetadata = {
    version, sourceCommit, repository: RELEASE_REPOSITORY, minimumNodeMajor: 20,
    files: Object.fromEntries(files.map((name) => [name, sha256(fs.readFileSync(path.join(skill, name)))])),
  };
  fs.mkdirSync(output, { recursive: true });
  const archive = path.join(output, assetName(version));
  const checksum = `${archive}.sha256`;
  const zip = new ZipFile();
  // Fixed timestamps and sorted files make retries produce the same archive.
  const options = { mtime: new Date("2000-01-01T00:00:00Z"), mode: 0o100644, forceDosTimestamp: true };
  const writing = pipeline(zip.outputStream, fs.createWriteStream(archive));
  for (const name of files) zip.addBuffer(fs.readFileSync(path.join(skill, name)), `semantic-flow/${name}`, options);
  zip.addBuffer(Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`), "semantic-flow/RELEASE.json", options);
  zip.end();
  await writing;
  fs.writeFileSync(checksum, `${sha256(fs.readFileSync(archive))}  ${path.basename(archive)}\n`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-flow-package-"));
  try {
    const extracted = path.join(temporary, "semantic-flow");
    await unpackDistribution(fs.readFileSync(archive), extracted, version);
    const run = (name: string, ...args: string[]) => execFileSync(process.execPath, [path.join(extracted, "scripts", `${name}.mjs`), ...args], { cwd: temporary, windowsHide: true, encoding: "utf8" });
    // Runtime commands operate in a user's Git repository, never the build checkout.
    execFileSync("git", ["init", "-b", "main"], { cwd: temporary, windowsHide: true, stdio: "ignore" });
    const installed = JSON.parse(run("semantic-flow", "version", "--json"));
    if (installed.skillVersion !== version || installed.sourceCommit !== sourceCommit) throw new Error("Extracted skill reports incorrect release provenance.");
    for (const name of ["semantic-flow", "semantic-implementation", "review-feedback", "semantic-view"]) run(name, "--help");
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  return { archive, checksum, version, sourceCommit };
}

export async function publishRelease(
  artifact: { archive: string; checksum: string; version: string; sourceCommit: string },
  notesFile: string,
  github: (...args: string[]) => string = gh,
): Promise<string> {
  const { version, sourceCommit } = artifact, tag = `v${version}`;
  parseVersion(version);
  const notes = fs.readFileSync(notesFile, "utf8");
  validateNotes(notes, version);
  const ref = JSON.parse(github("api", `repos/${RELEASE_REPOSITORY}/git/ref/tags/${tag}`));
  let object = ref.object;
  // Annotated tags point to a tag object; lightweight tags point straight to a commit.
  for (let depth = 0; object?.type === "tag" && depth < 10; depth++) {
    object = JSON.parse(github("api", `repos/${RELEASE_REPOSITORY}/git/tags/${object.sha}`)).object;
  }
  if (object?.type !== "commit" || object.sha !== sourceCommit) throw new Error("Remote release tag does not identify the tested source commit.");
  const releases = JSON.parse(github("api", "--paginate", "--slurp", `repos/${RELEASE_REPOSITORY}/releases?per_page=100`)).flat();
  const existing = releases.find((release) => release.tag_name === tag);
  if (existing && !existing.draft) throw new Error(`${tag} is already published; published versions are never replaced.`);
  const newer = releases.some((release) => {
    if (release.draft || release.prerelease) return false;
    try { return compareVersions(release.tag_name.replace(/^v/, ""), version) > 0; } catch { return false; }
  });
  if (!existing) github("release", "create", tag, "--repo", RELEASE_REPOSITORY, "--verify-tag", "--draft", "--title", tag, "--notes-file", notesFile);
  else github("release", "edit", tag, "--repo", RELEASE_REPOSITORY, "--title", tag, "--notes-file", notesFile);
  // Only drafts may have assets replaced on retry.
  github("release", "upload", tag, artifact.archive, artifact.checksum, "--repo", RELEASE_REPOSITORY, "--clobber");
  const downloaded = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-flow-published-"));
  try {
    github("release", "download", tag, "--repo", RELEASE_REPOSITORY, "--dir", downloaded, "--pattern", path.basename(artifact.archive), "--pattern", path.basename(artifact.checksum));
    for (const file of [artifact.archive, artifact.checksum]) {
      if (sha256(fs.readFileSync(file)) !== sha256(fs.readFileSync(path.join(downloaded, path.basename(file))))) throw new Error("Uploaded release bytes differ from the tested package.");
    }
    const draft = JSON.parse(github("release", "view", tag, "--repo", RELEASE_REPOSITORY, "--json", "body,isDraft"));
    if (!draft.isDraft || draft.body !== notes) throw new Error("Draft release notes do not match the reviewed changelog.");
    github("release", "edit", tag, "--repo", RELEASE_REPOSITORY, "--draft=false", `--latest=${!newer}`);
    const published = JSON.parse(github("release", "view", tag, "--repo", RELEASE_REPOSITORY, "--json", "isDraft,isPrerelease,url"));
    if (published.isDraft || published.isPrerelease) throw new Error("Release did not become eligible for updates.");
    return published.url;
  } finally { fs.rmSync(downloaded, { recursive: true, force: true }); }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "next" || command === "bump") {
    if (args.length > 2 || (args[1] && args[1] !== "--stable")) throw new Error("Usage: release next|bump breaking|feature|fix|none [--stable]");
    const pkg = json(manifestFile);
    const next = nextVersion(pkg.version, args[0] as "breaking" | "feature" | "fix" | "none", args[1] === "--stable");
    if (command === "bump") {
      if (git("tag", "--list", `v${next}`)) throw new Error(`Tag v${next} already exists.`);
      const lockFile = path.join(root, "scripts/package-lock.json"), lock = json(lockFile);
      pkg.version = next; lock.version = next; lock.packages[""].version = next;
      fs.writeFileSync(manifestFile, `${JSON.stringify(pkg, null, 2)}\n`);
      fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
      fs.writeFileSync(path.join(root, "skills/semantic-flow/VERSION"), `${next}\n`);
    }
    console.log(next);
  } else if (command === "package" || command === "publish") {
    if (args.length > 1) throw new Error("Usage: release package|publish [output-directory]");
    const output = path.resolve(args[0] || path.join(root, "dist"));
    if (command === "package") console.log(JSON.stringify(await packageRelease(output), null, 2));
    else {
      const version = json(manifestFile).version;
      parseVersion(version);
      if (git("rev-parse", `refs/tags/v${version}^{commit}`) !== git("rev-parse", "HEAD")) throw new Error(`Check out the exact v${version} tag before publishing.`);
      console.log(await publishRelease(await packageRelease(output), path.join(root, `releases/${version}.md`)));
    }
  } else throw new Error("Usage: release next|bump <change> [--stable], package [directory], or publish [directory].");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
