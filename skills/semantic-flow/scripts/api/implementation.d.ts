import type { SpecificationSourceKind } from "./shared.js";
export interface InitializeImplementationOptions {
    /** Stable kebab-case identifier for the complete implementation. */
    "implementation-id": string;
    /** Human-readable title for the complete body of work. */
    title: string;
    /** Concise summary of the implementation scope. */
    summary: string;
    /** Target branch revision immediately before the first semantic stage. @defaultValue "<target-branch>" */
    "base-revision"?: string;
    /** Branch into which the completed implementation is intended to merge. */
    "target-branch": string;
    /** Folder-like prefix shared by every stage branch. @defaultValue "semantic-flow/<implementation-id>" */
    "branch-prefix"?: string;
    /** Stable kebab-case identifier for the initial specification. */
    "specification-id": string;
    /** Human-readable title for the initial specification. */
    "specification-title": string;
    /** Concise description of the required behavior. */
    "specification-summary": string;
    /** Origin type for the specification, such as local or azure-devops. */
    "source-kind": SpecificationSourceKind;
    /** Identifier at the specification source, such as a story number. */
    "source-reference": string;
    /** Optional URL for the source specification. */
    "source-url"?: string;
    /** Acceptance criteria formatted as `<criterion-id>=<text>`; supply one entry per criterion. */
    criterion: readonly string[];
}
/**
 * Initializes a semantic implementation and its first specification.
 * @cli semantic-implementation.mjs
 * @command init
 */
export declare function initializeImplementation(options: InitializeImplementationOptions): void;
export interface AddSpecificationOptions {
    /** Stable kebab-case identifier for the specification. */
    "specification-id": string;
    /** Human-readable specification title. */
    "specification-title": string;
    /** Concise description of the required behavior. */
    "specification-summary": string;
    /** Origin type for the specification, such as local or azure-devops. */
    "source-kind": SpecificationSourceKind;
    /** Identifier at the specification source, such as a story number. */
    "source-reference": string;
    /** Optional URL for the source specification. */
    "source-url"?: string;
    /** Acceptance criteria formatted as `<criterion-id>=<text>`; supply one entry per criterion. */
    criterion: readonly string[];
}
/**
 * Adds another specification to the active implementation.
 * @cli semantic-implementation.mjs
 * @command specification add
 */
export declare function addSpecification(options: AddSpecificationOptions): void;
