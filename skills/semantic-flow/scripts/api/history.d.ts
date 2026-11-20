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
    /** The commit, or the range `<base>..<head>`, that landed the work on the
     * target branch, as the reviewer supplied it. Without it, landing is found by
     * ancestry or recorded as unknown. */
    landed?: string;
    /** Archive commit message. @defaultValue "Archive <implementation-id> semantic implementation" */
    message?: string;
}
/**
 * Archives a finished implementation under `refs/semantic-review/archive/<implementation-id>`:
 * a commit on top of the published metadata commit that adds the landing
 * record. Publishes the current artifact first when the metadata branch does not
 * hold it, then removes the active artifact. Adds nothing to the target branch,
 * needs no checkout and never deletes stage branches. Landing is the supplied
 * commits, else found when the target branch contains the final stage head,
 * else unknown; an unknown landing may come with a suggested match.
 * @cli semantic-flow.mjs
 * @command implementation archive
 */
export declare function archiveImplementation(options?: ArchiveImplementationOptions): void;
export interface ArchiveLandingOptions {
    /** Implementation ID of the archive. */
    id: string;
    /** The commit, or the range `<base>..<head>`, that landed the work, as the
     * reviewer supplied it. Without it, an unknown landing is replaced only when
     * the target branch now contains the final stage head. */
    landed?: string;
}
/**
 * Records where an archived implementation landed, replacing the archive's
 * landing record. Refused once the archive is shared.
 * @cli semantic-flow.mjs
 * @command implementation archive landing
 */
export declare function recordArchiveLanding(options: ArchiveLandingOptions): void;
export interface ShareArchiveOptions {
    /** Implementation ID of the archive. */
    id: string;
    /** Tag message. @defaultValue "Semantic implementation <implementation-id>, <landing>" */
    message?: string;
}
/**
 * Shares an archive as the annotated tag `semantic-review/archive/<implementation-id>`
 * and prints the command that pushes it. The tag is created once and never
 * moved, so the archive's landing record cannot change afterwards. Pushing
 * the tag sends the artifact, its evidence and the stage commits.
 * @cli semantic-flow.mjs
 * @command implementation archive share
 */
export declare function shareArchive(options: ShareArchiveOptions): void;
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
