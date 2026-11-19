export const RELEASE_REPOSITORY = "MortenChristiansenOrg/semantic-code-review";

export function parseVersion(version: string): number[] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Expected a release version such as 0.2.0; got ${version}.`);
  }
  const parts = version.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error("Version components are too large.");
  return parts;
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left), b = parseVersion(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

export const RELEASE_CHANGES = ["breaking", "feature", "fix", "none"] as const;
export type ReleaseChange = (typeof RELEASE_CHANGES)[number];

export function isReleaseChange(value: unknown): value is ReleaseChange {
  return RELEASE_CHANGES.some((change) => change === value);
}

/** The next version for a change classification given on the command line. */
export function nextVersion(current: string, change: string, stable = false): string {
  const [major, minor, patch] = parseVersion(current);
  if (!isReleaseChange(change)) throw new Error("Choose breaking, feature, fix, or none.");
  if (stable) {
    if (major !== 0) throw new Error("The explicit stable transition only applies before 1.0.0.");
    return "1.0.0";
  }
  if (change === "none") throw new Error("There are no releasable changes.");
  const result = major === 0 ? `0.${minor + 1}.0`
    : change === "breaking" ? `${major + 1}.0.0`
    : change === "feature" ? `${major}.${minor + 1}.0`
    : `${major}.${minor}.${patch + 1}`;
  parseVersion(result);
  return result;
}

export function assetName(version: string): string {
  parseVersion(version);
  return `semantic-flow-${version}.zip`;
}
