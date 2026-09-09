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

export function nextVersion(current: string, change: "breaking" | "feature" | "fix" | "none", stable = false): string {
  const [major, minor, patch] = parseVersion(current);
  if (!["breaking", "feature", "fix", "none"].includes(change)) throw new Error("Choose breaking, feature, fix, or none.");
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
