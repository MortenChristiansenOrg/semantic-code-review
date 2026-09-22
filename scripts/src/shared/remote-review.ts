/** Remote reviews own their clone and artifact projection inside the private review store. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { atomicJson, hasPendingDeletion, readReview, reviewDirectory, reviewId, withReviewLock, type ReviewRecord } from "./review-store.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import commonSchema from "../../../standard/v0.1/schema/common.schema.json";
import manifestSchema from "../../../standard/v0.1/schema/manifest.schema.json";
import stageSchema from "../../../standard/v0.1/schema/stage.schema.json";
import specificationSchema from "../../../standard/v0.1/schema/specification.schema.json";
import { reviewEnvironment } from "./review-context.js";

function git(root: string, args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=", "-c", "core.fsmonitor=false", "-c", "core.longpaths=true", ...args], {
    cwd: root, env: { ...reviewEnvironment(), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" }, encoding: "utf8", windowsHide: true,
    maxBuffer: 64 * 1024 * 1024, timeout: 120_000, stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}
function optional(root: string, args: string[]) { try { return git(root, args); } catch { return null; } }
function branchName(root: string, name: string) {
  if (!name || name.startsWith("-") || !optional(root, ["check-ref-format", "--branch", name])) throw new Error("Invalid remote branch name.");
  return name;
}
function files(root: string, base: string, head: string) {
  const fields = git(root, ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "-M", base, head]).split("\0");
  const result = [];
  for (let i = 0; fields[i];) {
    const status = fields[i++], oldPath = fields[i++], renamed = status.startsWith("R"), file = renamed ? fields[i++] : oldPath;
    if (file === ".semantic-review" || file.startsWith(".semantic-review/")) continue;
    result.push({ path: file, kind: renamed ? "renamed" : status === "A" ? "added" : status === "D" ? "deleted" : "modified", ...(renamed ? { previousPath: oldPath } : {}) });
  }
  return result;
}
function stage(root: string, id: string, title: string, summary: string, base: string, head: string, branch: string) {
  const changed = files(root, base, head);
  return { id, title, summary, rationale: "Reconstructed from Git history to show the complete changed files in this range.", dependsOn: [], specificationRefs: [],
    change: { branch, baseRevision: base, headRevision: head, files: changed },
    nodes: [{ id: "changes", description: title, changes: changed.map((file) => ({ path: file.path, classification: "behavior" })) }] };
}
let validator: Ajv2020;
function valid(schema: { $id: string }, document: unknown) {
  if (!validator) {
    validator = new Ajv2020({ strict: true, strictRequired: false });
    addFormats(validator);
    for (const item of [commonSchema, manifestSchema, stageSchema, specificationSchema]) validator.addSchema(item);
  }
  return validator.validate(schema.$id, document);
}
function artifact(root: string, ref: string, head: string) {
  const text = optional(root, ["show", `${ref}:.semantic-review/manifest.json`]);
  if (!text) return null;
  try {
    const manifest = JSON.parse(text);
    if (!valid(manifestSchema, manifest) || !manifest.stages.length) return null;
    let stages = manifest.stages.map((id) => JSON.parse(git(root, ["show", `${ref}:.semantic-review/stages/${id}.json`])));
    if (!stages.every((s, index) => valid(stageSchema, s) && s.id === manifest.stages[index])) return null;
    // Only reuse metadata for this exact reviewed range, never unrelated or stale published work.
    const end = stages.findIndex((s) => s.change?.headRevision === head);
    if (end < 0) return null;
    stages = stages.slice(0, end + 1);
    manifest.stages = manifest.stages.slice(0, end + 1);
    for (const s of stages) {
      for (const revision of [s.change.baseRevision, s.change.headRevision]) {
        if (!/^[a-f0-9]{40,64}$/.test(revision) || optional(root, ["rev-parse", "--verify", `${revision}^{commit}`]) !== revision) return null;
      }
      if (optional(root, ["merge-base", "--is-ancestor", s.change.headRevision, head]) === null) return null;
    }
    const requirements = (manifest.requirements || []).map((id) => JSON.parse(git(root, ["show", `${ref}:.semantic-review/requirements/${id}.json`])));
    if (!requirements.every((r, index) => valid(specificationSchema, r) && r.id === manifest.requirements[index])) return null;
    return { manifest, stages, requirements };
  } catch { return null; }
}
function projection(record: ReviewRecord, head: string) {
  const root = record.repositoryRoot, remote = record.remote!;
  let semantic = artifact(root, head, head);
  if (!semantic) {
    // Publication lives on a sibling metadata branch. Match by recorded stage head,
    // including a stage below the top of a stack, without trusting branch-name guesses.
    const refs = git(root, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"]).split("\n").filter((ref) => ref.endsWith("/metadata"));
    for (const ref of refs) { semantic = artifact(root, ref, head); if (semantic) break; }
  }
  if (semantic) {
    const overview = stage(root, "branch", "All branch changes", "Approve files here to track later updates, including updates without published metadata.", semantic.stages[0].change.baseRevision, head, remote.branch);
    // Namespace imported IDs so an authored stage named "branch" cannot replace
    // the stable cumulative stage used for approvals across presentation changes.
    const stages = semantic.stages.map((s) => ({ ...s, id: `semantic-${s.id}`, dependsOn: s.dependsOn.map((id) => `semantic-${id}`) }));
    return { ...semantic, stages: [overview, ...stages], manifest: { ...semantic.manifest, implementationId: record.implementationId, stages: ["branch", ...stages.map((s) => s.id)] } };
  }
  const target = git(root, ["rev-parse", "--verify", `refs/remotes/origin/${remote.targetBranch}^{commit}`]);
  const base = git(root, ["merge-base", head, target]);
  const commits = git(root, ["rev-list", "--reverse", "--first-parent", `${base}..${head}`]).split("\n").filter(Boolean);
  const stages = [stage(root, "branch", "All branch changes", `Changes in ${remote.branch} relative to ${remote.targetBranch}. Approve files here to track later updates.`, base, head, remote.branch)];
  for (const commit of commits) {
    const parent = git(root, ["rev-parse", `${commit}^1`]);
    const message = git(root, ["show", "-s", "--format=%s%n%b", commit]);
    stages.push(stage(root, `commit-${commit}`, message.split("\n")[0], `${commit.slice(0, 12)} · ${git(root, ["show", "-s", "--format=%an · %aI", commit])}\n${message}`, parent, commit, remote.branch));
  }
  return { manifest: { formatVersion: "0.1", implementationId: record.implementationId, title: remote.branch,
    summary: "Remote branch review. Personal notes and approvals stay on this computer.", targetBranch: remote.targetBranch, baseRevision: base, requirements: [], stages: stages.map((s) => s.id) }, stages, requirements: [] };
}
function refresh(record: ReviewRecord) {
  const root = record.repositoryRoot, remote = record.remote!;
  git(root, ["fetch", "--prune", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  const head = git(root, ["rev-parse", "--verify", `refs/remotes/origin/${remote.branch}^{commit}`]);
  const projected = projection(record, head); // Complete all fallible discovery before replacing the visible artifact.
  const next = path.join(reviewDirectory(record.id), ".artifact-next");
  fs.rmSync(next, { recursive: true, force: true });
  for (const child of ["stages", "requirements"]) fs.mkdirSync(path.join(next, child), { recursive: true });
  for (const s of projected.stages) atomicJson(path.join(next, "stages", `${s.id}.json`), s);
  for (const r of projected.requirements) atomicJson(path.join(next, "requirements", `${r.id}.json`), r);
  atomicJson(path.join(next, "manifest.json"), projected.manifest);
  const artifactPath = path.join(root, ".semantic-review"), backup = path.join(reviewDirectory(record.id), ".artifact-previous");
  const previousHead = optional(root, ["rev-parse", "--verify", "HEAD"]);
  fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(artifactPath)) fs.renameSync(artifactPath, backup);
  try {
    git(root, ["checkout", "--force", "--detach", head]);
    fs.rmSync(artifactPath, { recursive: true, force: true });
    fs.renameSync(next, artifactPath);
  } catch (error) {
    if (previousHead) optional(root, ["checkout", "--force", "--detach", previousHead]);
    fs.rmSync(artifactPath, { recursive: true, force: true });
    if (fs.existsSync(backup)) fs.renameSync(backup, artifactPath);
    throw error;
  }
  fs.rmSync(backup, { recursive: true, force: true });
  record.remote = { ...remote, headRevision: head, refreshedAt: new Date().toISOString() };
  record.title = projected.manifest.title;
  atomicJson(path.join(reviewDirectory(record.id), "review.json"), record);
  return record;
}
export function refreshRemoteReview(id: string, generation: string) {
  return withReviewLock(id, () => {
    const record = readReview(id);
    if (record.generation !== generation) throw new Error("The remote review was replaced. Reopen it.");
    if (!record.remote) throw new Error("Only remote reviews can fetch branch updates.");
    return refresh(record);
  });
}
export function startRemoteReview(sourceRoot: string, requestedBranch: string) {
  sourceRoot = fs.realpathSync(sourceRoot);
  const remotes = git(sourceRoot, ["remote"]).split("\n").filter(Boolean);
  let remoteName = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : "";
  let branch = requestedBranch;
  const qualified = [...remotes].sort((a, b) => b.length - a.length).find((remote) => branch.startsWith(remote + "/"));
  if (qualified) { remoteName = qualified; branch = branch.slice(qualified.length + 1); }
  if (!remoteName) throw new Error("Select a remote with --branch <remote>/<branch>; no default remote is available.");
  branchName(sourceRoot, branch);
  let url = git(sourceRoot, ["remote", "get-url", remoteName]);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^[^/]+:/.test(url)) url = path.resolve(sourceRoot, url);
  const key = `remote-${createHash("sha256").update(JSON.stringify([url, branch])).digest("hex").slice(0, 24)}`;
  const id = reviewId(sourceRoot, key);
  return withReviewLock(id, () => {
    const directory = reviewDirectory(id), recordFile = path.join(directory, "review.json");
    if (hasPendingDeletion(id)) throw new Error("Finish pending review deletion before starting a fresh review.");
    if (fs.existsSync(recordFile)) return readReview(id); // Opening preserves the reviewed snapshot; refresh is explicit.
    // An interrupted first clone has no registered state and can be retried.
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      const root = path.join(directory, "checkout");
      git(sourceRoot, ["clone", "--config", "core.longpaths=true", "--no-checkout", "--no-local", "--no-tags", "--", url, root]);
      const targetRef = optional(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
      const targetBranch = targetRef?.replace(/^refs\/remotes\/origin\//, "") || ["main", "master"].find((name) => optional(root, ["rev-parse", "--verify", `refs/remotes/origin/${name}^{commit}`]));
      if (!targetBranch) throw new Error("The remote has no default branch. Set its default branch before starting a review.");
      branchName(root, targetBranch);
      const now = new Date().toISOString();
      for (const child of ["feedback", "attachments", "snapshots"]) fs.mkdirSync(path.join(directory, child));
      const record: ReviewRecord = { id, generation: randomUUID(), repositoryRoot: fs.realpathSync(root), implementationId: key,
        title: branch, createdAt: now, updatedAt: now, completedAt: null, state: {}, remote: { sourceRoot, remoteName, branch, targetBranch } };
      return refresh(record);
    } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  });
}
