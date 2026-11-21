export const RELEASE_REPOSITORY = "MortenChristiansenOrg/semantic-code-review";

/** A release version: `MAJOR.MINOR.PATCH`, or a prerelease of it, `MAJOR.MINOR.PATCH-rc.N`. */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** The `N` of `-rc.N`, counted from 1; null for a normal release. */
  prerelease: number | null;
}

export function parseVersion(version: string): ParsedVersion {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/.exec(version);
  if (!match) throw new Error(`Expected a release version such as 0.2.0 or 0.2.0-rc.1; got ${version}.`);
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  const prerelease = match[4] === undefined ? null : Number(match[4]);
  if (![major, minor, patch, prerelease ?? 0].every(Number.isSafeInteger)) throw new Error("Version components are too large.");
  return { major, minor, patch, prerelease };
}

export function isPrerelease(version: string): boolean {
  return parseVersion(version).prerelease !== null;
}

/** The normal release a version belongs to: `0.15.0` for `0.15.0-rc.2` and for `0.15.0`. */
export function normalVersion(version: string): string {
  const { major, minor, patch } = parseVersion(version);
  return `${major}.${minor}.${patch}`;
}

/** Orders `0.14.0 < 0.15.0-rc.1 < 0.15.0-rc.2 < 0.15.0`. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left), b = parseVersion(right);
  for (const part of ["major", "minor", "patch"] as const) if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

export const RELEASE_CHANGES = ["breaking", "feature", "fix", "none"] as const;
export type ReleaseChange = (typeof RELEASE_CHANGES)[number];

export function isReleaseChange(value: unknown): value is ReleaseChange {
  return RELEASE_CHANGES.some((change) => change === value);
}

/** 1 for a major, 2 for a minor and 3 for a patch increment. */
const changeLevel = { breaking: 1, feature: 2, fix: 3 } as const;

/** The normal version that one increment of `change` makes from the normal version `from`. */
function increment(from: ParsedVersion, change: "breaking" | "feature" | "fix"): string {
  const { major, minor, patch } = from;
  return major === 0 ? `0.${minor + 1}.0`
    : change === "breaking" ? `${major + 1}.0.0`
    : change === "feature" ? `${major}.${minor + 1}.0`
    : `${major}.${minor}.${patch + 1}`;
}

/**
 * The next version for a change classification given on the command line.
 * The change always describes everything since the last normal release.
 *
 * From a prerelease, the target is its normal version. From 1.0 on, a change
 * that needs a larger increment than that version already has (for example
 * `breaking` for `1.3.0-rc.1`) makes the target that increment of it instead
 * (`2.0.0`). `stable` makes `1.0.0` the target while the current version is
 * below it, which includes the `1.0.0` prereleases. With `prerelease`, the
 * result is the next prerelease of the target: `-rc.N+1` when the current
 * version is a prerelease of the target, otherwise `-rc.1`.
 */
export function nextVersion(current: string, change: string, options: { stable?: boolean; prerelease?: boolean } = {}): string {
  const parsed = parseVersion(current);
  if (!isReleaseChange(change)) throw new Error("Choose breaking, feature, fix, or none.");
  if (change === "none") throw new Error("There are no releasable changes.");
  let target: string;
  if (options.stable) {
    if (compareVersions(current, "1.0.0") >= 0) throw new Error("The explicit stable transition only applies before 1.0.0.");
    target = "1.0.0";
  } else {
    if (parsed.prerelease === null) target = increment(parsed, change);
    else {
      // The level of the increment the prerelease's normal version already has.
      const level = parsed.patch !== 0 ? 3 : parsed.minor !== 0 ? 2 : 1;
      target = parsed.major !== 0 && changeLevel[change] < level ? increment(parsed, change) : normalVersion(current);
    }
  }
  const result = !options.prerelease ? target
    : normalVersion(current) === target && parsed.prerelease !== null ? `${target}-rc.${parsed.prerelease + 1}`
    : `${target}-rc.1`;
  parseVersion(result);
  return result;
}

export function assetName(version: string): string {
  parseVersion(version);
  return `semantic-flow-${version}.zip`;
}
