/** Remote reviews own their clone and artifact projection inside the private review store. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { atomicJson, isReviewId, newReviewId, projectionDirectory, readReview, reviewDirectory, reviewHome, withReviewLock, type RemoteReview, type ReviewRecord } from "./review-store.js";
import { MANIFEST_SCHEMA_ID, SPECIFICATION_SCHEMA_ID, STAGE_SCHEMA_ID, type Evidence, type Linked, type Specification, type Stage } from "./documents.js";
import { jsonBytes, parseJson } from "./json.js";
import { hasFile, readPublishedArtifact, replaceArtifactDirectory, type ArtifactFiles, type GitRunner } from "./artifact-store.js";
import { isDocument } from "./schema-validation.js";
import { reviewEnvironment } from "./review-context.js";
import { SUBPROCESS_MAX_BUFFER } from "./subprocess.js";
import { MAX_EVIDENCE_ATTACHMENT_BYTES, MAX_EVIDENCE_TOTAL_BYTES, sha256Hex } from "./evidence.js";

function git(root: string, args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=", "-c", "core.fsmonitor=false", "-c", "core.longpaths=true", ...args], {
    cwd: root, env: { ...reviewEnvironment(), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" }, encoding: "utf8", windowsHide: true,
    maxBuffer: SUBPROCESS_MAX_BUFFER, timeout: 120_000, stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}
function optional(root: string, args: string[]) { try { return git(root, args); } catch { return null; } }
const MAX_REMOTE_EVIDENCE_BYTES = 10 * MAX_EVIDENCE_TOTAL_BYTES;
type EvidenceFile = { files: ArtifactFiles; source: string; sha256: string; size: number };
/** Runs Git in the managed clone for the artifact store, which may pass input. */
function gitRunner(root: string): GitRunner {
  return (args, input) => execFileSync("git", ["-c", "core.hooksPath=", "-c", "core.fsmonitor=false", "-c", "core.longpaths=true", ...args], {
    cwd: root, env: { ...reviewEnvironment(), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" }, windowsHide: true, input,
    maxBuffer: SUBPROCESS_MAX_BUFFER, timeout: 120_000, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
  });
}
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
function artifact(root: string, ref: string, head: string) {
  const files = readPublishedArtifact(root, ref, gitRunner(root));
  if (!files || !hasFile(files, "manifest.json")) return null;
  const document = (file: string) => parseJson(files.read(file).toString("utf8"));
  try {
    const manifest = document("manifest.json");
    if (!isDocument(MANIFEST_SCHEMA_ID, manifest) || !manifest.stages.length) return null;
    let stages = manifest.stages.map((id) => document(`stages/${id}.json`))
      .filter((s, index): s is Stage => isDocument(STAGE_SCHEMA_ID, s) && s.id === manifest.stages[index]);
    if (stages.length !== manifest.stages.length) return null;
    // Only reuse metadata for this exact reviewed range, never unrelated or stale published work.
    const end = stages.findIndex((s) => s.change.headRevision === head);
    if (end < 0) return null;
    stages = stages.slice(0, end + 1);
    manifest.stages = manifest.stages.slice(0, end + 1);
    for (const s of stages) {
      for (const revision of [s.change.baseRevision, s.change.headRevision]) {
        if (!/^[a-f0-9]{40,64}$/.test(revision) || optional(root, ["rev-parse", "--verify", `${revision}^{commit}`]) !== revision) return null;
      }
      if (optional(root, ["merge-base", "--is-ancestor", s.change.headRevision, head]) === null) return null;
    }
    const requirements = manifest.requirements.map((id) => document(`requirements/${id}.json`))
      .filter((r, index): r is Specification => isDocument(SPECIFICATION_SCHEMA_ID, r) && r.id === manifest.requirements[index]);
    if (requirements.length !== manifest.requirements.length) return null;
    return { manifest, stages, requirements, files };
  } catch { return null; }
}
// Unusable attachments stay listed but aren't extracted, so the viewer reports them as unavailable.
// Remote metadata is untrusted, so only an inventory is built here: each file is read once, within a budget.
function projectEvidence(files: ArtifactFiles, stageId: string, item: Linked<Evidence>, evidenceFiles: Map<string, EvidenceFile>): Linked<Evidence> {
  if (!item.attachments) return item;
  const prefix = `evidence/${stageId}/`;
  const attachments = item.attachments.map((attachment) => {
    if (!attachment.path.startsWith(prefix)) return attachment;
    const projected = { ...attachment, path: `evidence/semantic-${stageId}/${attachment.path.slice(prefix.length)}` };
    if (evidenceFiles.has(projected.path)) return projected;
    const source = attachment.path;
    const size = hasFile(files, source) ? files.size(source) : null;
    const used = [...evidenceFiles.values()].reduce((sum, file) => sum + file.size, 0);
    if (size !== null && size <= MAX_EVIDENCE_ATTACHMENT_BYTES && used + size <= MAX_REMOTE_EVIDENCE_BYTES) {
      evidenceFiles.set(projected.path, { files, source, sha256: attachment.sha256, size });
    }
    return projected;
  });
  return { ...item, attachments };
}
function projection(record: ReviewRecord, remote: RemoteReview, head: string) {
  const root = record.repositoryRoot;
  let semantic = artifact(root, head, head);
  if (!semantic) {
    // Publication lives on a sibling metadata branch. Match by recorded stage head,
    // including a stage below the top of a stack, without trusting branch-name guesses.
    const refs = git(root, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"]).split("\n").filter((ref) => ref.endsWith("/metadata"));
    for (const ref of refs) { semantic = artifact(root, ref, head); if (semantic) break; }
  }
  if (semantic) {
    const { files } = semantic;
    // Keep authored and reconstructed stage identities separate across refreshes.
    const evidenceFiles = new Map<string, EvidenceFile>();
    const stages = semantic.stages.map((s) => ({ ...s, id: `semantic-${s.id}`, dependsOn: s.dependsOn.map((id) => `semantic-${id}`),
      evidence: s.evidence.map((item) => projectEvidence(files, s.id, item, evidenceFiles)) }));
    return { ...semantic, stages, evidenceFiles, manifest: { ...semantic.manifest, implementationId: record.implementationId, stages: stages.map((s) => s.id) } };
  }
  const target = git(root, ["rev-parse", "--verify", `refs/remotes/origin/${remote.targetBranch}^{commit}`]);
  const base = git(root, ["merge-base", head, target]);
  const commits = git(root, ["rev-list", "--reverse", "--first-parent", `${base}..${head}`]).split("\n").filter(Boolean);
  const stages = [];
  for (const commit of commits) {
    const parent = git(root, ["rev-parse", `${commit}^1`]);
    const message = git(root, ["show", "-s", "--format=%s%n%b", commit]);
    stages.push(stage(root, `commit-${commit}`, message.split("\n")[0], `${commit.slice(0, 12)} · ${git(root, ["show", "-s", "--format=%an · %aI", commit])}\n${message}`, parent, commit, remote.branch));
  }
  return { manifest: { formatVersion: "0.1", implementationId: record.implementationId, title: remote.branch,
    summary: "Remote branch review. Personal notes and approvals stay on this computer.", targetBranch: remote.targetBranch, baseRevision: base, requirements: [], stages: stages.map((s) => s.id) }, stages, requirements: [], evidenceFiles: new Map<string, EvidenceFile>() };
}
function refresh(record: ReviewRecord, remote: RemoteReview) {
  const root = record.repositoryRoot;
  git(root, ["fetch", "--prune", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  const head = git(root, ["rev-parse", "--verify", `refs/remotes/origin/${remote.branch}^{commit}`]);
  const projected = projection(record, remote, head); // Complete all fallible discovery before replacing the visible artifact.
  // Evidence is read one file at a time, as the projection is written.
  function* files(): Generator<[string, Buffer]> {
    for (const s of projected.stages) yield [`stages/${s.id}.json`, jsonBytes(s)];
    for (const r of projected.requirements) yield [`requirements/${r.id}.json`, jsonBytes(r)];
    for (const [file, { files: source, source: sourcePath, sha256 }] of projected.evidenceFiles) {
      const bytes = source.read(sourcePath);
      if (sha256Hex(bytes) === sha256) yield [file, bytes];
    }
    yield ["manifest.json", jsonBytes(projected.manifest)];
  }
  const previousHead = optional(root, ["rev-parse", "--verify", "HEAD"]);
  let checkoutStarted = false;
  // The checkout and the projection stay on the same revision: a failed
  // refresh checks the previous revision out again and keeps the previous projection.
  replaceArtifactDirectory(projectionDirectory(record.id), files(), () => {
    checkoutStarted = true;
    git(root, ["checkout", "--force", "--detach", head]);
  }, () => {
    if (checkoutStarted && previousHead) git(root, ["checkout", "--force", "--detach", previousHead]);
  });
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
    return refresh(record, record.remote);
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
  const hash = createHash("sha256").update(JSON.stringify([url, branch])).digest("hex");
  const key = `remote-${hash.slice(0, 24)}`;
  // A remote review has a random ID and is found again by what it reviews, so any
  // checkout opens the same review. This lock name only serializes starting it.
  const startLock = `remote--${key}--${hash}`;
  return withReviewLock(startLock, () => {
    const existing = findRemoteReview(url, branch);
    if (existing) return existing; // Opening preserves the reviewed snapshot; refresh is explicit.
    const repository = url.replace(/[\\/]+$/, "").split(/[\\/:]/).pop()?.replace(/\.git$/, "") || "remote";
    const id = newReviewId(repository, branch);
    return withReviewLock(id, () => startNewRemoteReview(id, sourceRoot, remoteName, url, branch, key));
  });
}
/** The remote review of a remote URL and branch, if one is registered. Damaged
 * records are skipped, so one cannot hide the others. */
function findRemoteReview(url: string, branch: string): ReviewRecord | undefined {
  const directory = path.join(reviewHome(), "reviews");
  if (!fs.existsSync(directory)) return undefined;
  for (const id of fs.readdirSync(directory).filter(isReviewId).sort()) {
    let record: ReviewRecord;
    try { record = readReview(id); } catch { continue; }
    if (record.remote?.url === url && record.remote.branch === branch) return record;
  }
  return undefined;
}
/** Clones the remote into a new review. Caller holds the new review's lock. */
function startNewRemoteReview(id: string, sourceRoot: string, remoteName: string, url: string, branch: string, key: string) {
  const directory = reviewDirectory(id);
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
    const remote: RemoteReview = { sourceRoot, remoteName, url, branch, targetBranch };
    const record: ReviewRecord = { id, generation: randomUUID(), repositoryRoot: fs.realpathSync(root), implementationId: key,
      title: branch, createdAt: now, updatedAt: now, completedAt: null, state: {}, stateRevision: 0, remote };
    return refresh(record, remote);
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}
