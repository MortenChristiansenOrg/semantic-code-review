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
 * @cli semantic-flow.mjs
 * @command implementation restack
 */
export declare function restack(options: RestackOptions): void;
/**
 * Repairs unambiguous interrupted artifact mutations.
 * @cli semantic-flow.mjs
 * @command implementation repair
 */
export declare function repairArtifact(): void;
export interface PublishArtifactOptions {
    /** Metadata commit message. @defaultValue "Publish <implementation-id> semantic implementation" */
    message?: string;
}
/**
 * Commits validated semantic metadata to the metadata branch.
 * @cli semantic-flow.mjs
 * @command implementation publish
 */
export declare function publishArtifact(options?: PublishArtifactOptions): void;
export interface ValidateStackOptions {
    /** Emits machine-readable local stack information. */
    json?: true;
}
/**
 * Verifies stage branches and prints their local base chain.
 * @cli semantic-flow.mjs
 * @command implementation validate-stack
 */
export declare function validateStack(options?: ValidateStackOptions): void;
export interface PrepareBranchOptions {
    /** Local cumulative branch. Required for the first preparation and when rebinding. */
    branch?: string;
    /** Takes ownership of an existing branch and replaces its current tip with the reviewed head. */
    adopt?: true;
    /** Replaces the implementation's existing cumulative branch binding. Requires `branch`. */
    rebind?: true;
}
/**
 * Creates or updates the bound cumulative implementation branch and publishes
 * matching metadata without changing the worktree.
 * @cli semantic-flow.mjs
 * @command implementation prepare-branch
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
 * @cli semantic-flow.mjs
 * @command implementation archive
 */
export declare function archiveImplementation(options?: ArchiveImplementationOptions): void;
export interface ExportImplementationOptions {
    /** New or empty directory to write the artifact's files into. Without it, the artifact is printed as JSON. */
    destination?: string;
}
/**
 * Shows the active artifact in its full form, with the branch, base revision
 * and file inventory of each stage derived from Git, for inspection. Prints
 * one JSON object, or writes the files that publication would store plus any
 * working stage. Changing the written files does not change the artifact.
 * @cli semantic-flow.mjs
 * @command implementation export
 */
export declare function exportImplementation(options?: ExportImplementationOptions): void;
export interface ValidateArtifactOptions {
    /** Validates JSON schemas only and skips semantic and Git validation. The
     * recorded commits must still exist, because the stage inventories that the
     * schemas validate are derived from them. */
    "schema-only"?: true;
    /** Applies the stricter completion and publication validation gate. */
    publish?: true;
}
/**
 * Validates schemas, references, dependencies, artifact state, and Git state.
 * `schema-only` and `publish` are mutually exclusive.
 * @cli semantic-flow.mjs
 * @command implementation validate
 */
export declare function validateArtifact(options?: ValidateArtifactOptions): void;
