export interface RestackOptions {
  /** Earliest edited stage. Its recorded branch must be checked out. Mutually exclusive with `base`. */
  from?: string;
  /** Replacement trunk revision, usually the current target branch head. Mutually exclusive with `from`. */
  base?: string;
  /** Emits exact old and new revisions for every refreshed stage. */
  json?: true;
}

/**
 * Refreshes an edited stage branch and rebases every branch above it.
 * @cli semantic-implementation.mjs
 * @command restack
 */
export declare function restack(options: RestackOptions): void;

/**
 * Repairs unambiguous interrupted artifact mutations.
 * @cli semantic-implementation.mjs
 * @command repair
 */
export declare function repairArtifact(): void;

export interface PublishArtifactOptions {
  /** Metadata commit message. @defaultValue "Publish <implementation-id> semantic implementation" */
  message?: string;
}

/**
 * Commits validated semantic metadata to the metadata branch.
 * @cli semantic-implementation.mjs
 * @command publish
 */
export declare function publishArtifact(
  options?: PublishArtifactOptions,
): void;

export interface ValidateStackOptions {
  /** Emits machine-readable local stack information. */
  json?: true;
}

/**
 * Verifies stage branches and prints their local base chain.
 * @cli semantic-implementation.mjs
 * @command validate-stack
 */
export declare function validateStack(options?: ValidateStackOptions): void;

export interface PrepareBranchOptions {
  /** Local cumulative branch to create at the final reviewed stage head. */
  branch: string;
}

/**
 * Creates a local cumulative implementation branch without changing the worktree.
 * @cli semantic-implementation.mjs
 * @command prepare-branch
 */
export declare function prepareBranch(options: PrepareBranchOptions): void;

export interface ArchiveImplementationOptions {
  /** Repository-relative archive directory ending in `.semantic-review`. @defaultValue ".semantic-review-history/<implementation-id>/.semantic-review" */
  destination?: string;
  /** Archive commit message. @defaultValue "Archive <implementation-id> semantic implementation" */
  message?: string;
}

/**
 * Moves a merged and published implementation into repository history.
 * The target branch must be checked out, contain the final stage head, and have
 * a metadata branch that exactly matches the current artifact.
 * @cli semantic-implementation.mjs
 * @command archive
 */
export declare function archiveImplementation(options?: ArchiveImplementationOptions): void;

export interface ValidateArtifactOptions {
  /** Validates JSON schemas only and skips semantic and Git validation. */
  "schema-only"?: true;
  /** Applies the stricter completion and publication validation gate. */
  publish?: true;
}

/**
 * Validates schemas, references, dependencies, artifact state, and Git state.
 * `schema-only` and `publish` are mutually exclusive.
 * @cli semantic-implementation.mjs
 * @command validate
 */
export declare function validateArtifact(
  options?: ValidateArtifactOptions,
): void;
