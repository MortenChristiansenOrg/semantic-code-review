import fs from "node:fs/promises";
import path from "node:path";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class ArtifactError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ArtifactError";
    this.code = code;
    this.details = details;
  }
}

async function readJson(file, artifactRoot) {
  let content;
  try {
    content = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ArtifactError(
        "missing-document",
        `Artifact document is missing: ${relativePath(artifactRoot, file)}`,
      );
    }
    throw new ArtifactError(
      "unreadable-document",
      `Artifact document cannot be read: ${relativePath(artifactRoot, file)}`,
      error.message,
    );
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    throw new ArtifactError(
      "invalid-json",
      `Artifact document contains invalid JSON: ${relativePath(artifactRoot, file)}`,
      error.message,
    );
  }
}

function relativePath(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ArtifactError("invalid-document", `${label} must be an object.`);
  }
}

function requireId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new ArtifactError(
      "invalid-id",
      `${label} must be a lowercase kebab-case ID.`,
    );
  }
}

function requireIdList(value, label) {
  if (!Array.isArray(value)) {
    throw new ArtifactError("invalid-document", `${label} must be an array.`);
  }
  const seen = new Set();
  for (const id of value) {
    requireId(id, `${label} entry`);
    if (seen.has(id)) {
      throw new ArtifactError(
        "duplicate-id",
        `${label} contains duplicate ID ${id}.`,
      );
    }
    seen.add(id);
  }
}

function assertDocumentId(document, expectedId, label) {
  if (document.id !== expectedId) {
    throw new ArtifactError(
      "id-mismatch",
      `${label} ${expectedId} declares ID ${String(document.id)}.`,
    );
  }
}

async function readIndexedDocuments({
  artifactRoot,
  directory,
  ids,
  label,
}) {
  const documents = [];
  for (const id of ids) {
    const file = path.join(artifactRoot, directory, `${id}.json`);
    const document = await readJson(file, artifactRoot);
    requireObject(document, `${label} ${id}`);
    assertDocumentId(document, id, label);
    documents.push(document);
  }
  return documents;
}

async function readWorkingStages(artifactRoot) {
  const directory = path.join(artifactRoot, ".work", "stages");
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw new ArtifactError(
      "unreadable-work-state",
      "Working stage directory cannot be read.",
      error.message,
    );
  }

  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const stages = [];
  for (const entry of jsonFiles) {
    const expectedId = entry.name.slice(0, -".json".length);
    requireId(expectedId, "Working stage filename");
    const stage = await readJson(path.join(directory, entry.name), artifactRoot);
    requireObject(stage, `Working stage ${expectedId}`);
    assertDocumentId(stage, expectedId, "Working stage");
    stages.push(stage);
  }
  return stages;
}

function validateReferences({ manifest, requirements, stages, workingStages }) {
  const criteria = new Map();
  for (const requirement of requirements) {
    if (!Array.isArray(requirement.acceptanceCriteria)) {
      throw new ArtifactError(
        "invalid-document",
        `Requirement ${requirement.id} must contain acceptanceCriteria.`,
      );
    }
    const requirementCriteria = new Set();
    for (const criterion of requirement.acceptanceCriteria) {
      requireObject(criterion, `Criterion in ${requirement.id}`);
      requireId(criterion.id, `Criterion ID in ${requirement.id}`);
      if (requirementCriteria.has(criterion.id)) {
        throw new ArtifactError(
          "duplicate-id",
          `Requirement ${requirement.id} repeats criterion ${criterion.id}.`,
        );
      }
      requirementCriteria.add(criterion.id);
    }
    criteria.set(requirement.id, requirementCriteria);
  }

  const finalized = new Set();
  for (const stage of stages) {
    validateStageReferences(stage, criteria, finalized, "Stage");
    finalized.add(stage.id);
  }
  for (const stage of workingStages) {
    validateStageReferences(stage, criteria, finalized, "Working stage");
  }

  if (manifest.stages.length !== stages.length) {
    throw new ArtifactError(
      "stage-count-mismatch",
      "Loaded stage count does not match the manifest.",
    );
  }
}

function validateStageReferences(stage, criteria, availableStages, label) {
  if (!Array.isArray(stage.requirementRefs)) {
    throw new ArtifactError(
      "invalid-document",
      `${label} ${stage.id} must contain requirementRefs.`,
    );
  }
  for (const reference of stage.requirementRefs) {
    const [requirementId, criterionId, extra] = String(reference).split("#");
    if (
      extra !== undefined ||
      !criteria.get(requirementId)?.has(criterionId)
    ) {
      throw new ArtifactError(
        "unresolved-requirement",
        `${label} ${stage.id} references missing criterion ${reference}.`,
      );
    }
  }

  if (!Array.isArray(stage.dependsOn)) {
    throw new ArtifactError(
      "invalid-document",
      `${label} ${stage.id} must contain dependsOn.`,
    );
  }
  for (const dependency of stage.dependsOn) {
    if (!availableStages.has(dependency)) {
      throw new ArtifactError(
        "unresolved-dependency",
        `${label} ${stage.id} depends on unavailable stage ${dependency}.`,
      );
    }
  }
}

export async function readSemanticReview({
  repositoryRoot,
  includeWorkingStages = true,
} = {}) {
  if (!repositoryRoot) {
    throw new ArtifactError(
      "missing-repository-root",
      "repositoryRoot is required.",
    );
  }

  const root = path.resolve(repositoryRoot);
  const artifactRoot = path.join(root, ".semantic-review");
  const manifest = await readJson(
    path.join(artifactRoot, "manifest.json"),
    artifactRoot,
  );
  requireObject(manifest, "Manifest");
  requireIdList(manifest.requirements, "Manifest requirements");
  requireIdList(manifest.stages, "Manifest stages");

  const requirements = await readIndexedDocuments({
    artifactRoot,
    directory: "requirements",
    ids: manifest.requirements,
    label: "Requirement",
  });
  const stages = await readIndexedDocuments({
    artifactRoot,
    directory: "stages",
    ids: manifest.stages,
    label: "Stage",
  });
  const workingStages = includeWorkingStages
    ? await readWorkingStages(artifactRoot)
    : [];

  validateReferences({ manifest, requirements, stages, workingStages });

  return {
    repositoryRoot: root,
    artifactRoot,
    manifest,
    requirements,
    stages,
    workingStages,
  };
}
