import { assetName, compareVersions, parseVersion, RELEASE_REPOSITORY } from "./release-version.js";
import { MAX_ARCHIVE_BYTES, sha256 } from "./distribution.js";

const API = `https://api.github.com/repos/${RELEASE_REPOSITORY}`;
export interface ReleaseAsset { name: string; url: string; size: number; }
export interface GithubRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  body: string;
  assets: ReleaseAsset[];
}

export async function githubBytes(url: string, limit: number, asset = false): Promise<Buffer> {
  if (!url.startsWith(`${API}/`)) throw new Error("Unexpected release API URL.");
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  let response: Response;
  try {
    response = await fetch(url, { headers: {
      Accept: asset ? "application/octet-stream" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, signal: AbortSignal.timeout(60000) });
  } catch (error) { throw new Error(`Could not download the release; check your connection. ${String(error)}`); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub release request failed (HTTP ${response.status}). Check release availability, network access, and GH_TOKEN/GITHUB_TOKEN permissions or rate limits.`);
  }
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("Release download is too large.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty GitHub response.");
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw new Error("Release download is too large.");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

export async function listReleases(): Promise<GithubRelease[]> {
  const releases: GithubRelease[] = [];
  for (let page = 1; ; page++) {
    const result = JSON.parse((await githubBytes(`${API}/releases?per_page=100&page=${page}`, 8 * 1024 * 1024)).toString());
    if (!Array.isArray(result)) throw new Error("Invalid GitHub release list.");
    releases.push(...result);
    if (result.length < 100) break;
    if (page >= 100) throw new Error("Too many releases to resolve safely.");
  }
  return releases;
}

export function releaseVersion(release: GithubRelease): string | null {
  if (release.draft || release.prerelease || typeof release.tag_name !== "string" || !release.tag_name.startsWith("v")) return null;
  try { parseVersion(release.tag_name.slice(1)); return release.tag_name.slice(1); } catch { return null; }
}

export function selectRelease(releases: GithubRelease[], requested?: string): GithubRelease {
  if (requested) parseVersion(requested);
  const eligible = releases.filter((release) => releaseVersion(release) !== null)
    .sort((a, b) => compareVersions(releaseVersion(b)!, releaseVersion(a)!));
  const selected = requested ? eligible.find((release) => releaseVersion(release) === requested) : eligible[0];
  if (!selected) throw new Error(requested ? `No published release v${requested} exists.` : "No published release is available.");
  // A malformed newest release is an error, not permission to install older code.
  releaseAssets(selected);
  return selected;
}

export function releaseAssets(release: GithubRelease): { archive: ReleaseAsset; checksum: ReleaseAsset } {
  const version = releaseVersion(release);
  if (!version || !Array.isArray(release.assets)) throw new Error("Invalid published release.");
  const name = assetName(version);
  const find = (expected: string) => {
    const matches = release.assets.filter((asset) => asset.name === expected);
    if (matches.length !== 1 || !matches[0].url.startsWith(`${API}/releases/assets/`)) throw new Error(`Release ${release.tag_name} is missing a unique valid ${expected} asset.`);
    return matches[0];
  };
  return { archive: find(name), checksum: find(`${name}.sha256`) };
}

export async function downloadRelease(release: GithubRelease): Promise<Buffer> {
  const { archive, checksum } = releaseAssets(release);
  const checksumText = (await githubBytes(checksum.url, 1024, true)).toString().trim();
  const match = /^([a-f0-9]{64})  (\S+)$/.exec(checksumText);
  if (!match || match[2] !== archive.name) throw new Error("Invalid release checksum asset.");
  const bytes = await githubBytes(archive.url, MAX_ARCHIVE_BYTES, true);
  if (sha256(bytes) !== match[1]) throw new Error("Release archive checksum mismatch; installation was not changed.");
  return bytes;
}

export function upgradeNotes(releases: GithubRelease[], previous: string, target: string): string {
  let known = true;
  try { parseVersion(previous); } catch { known = false; }
  return releases.filter((release) => {
    const v = releaseVersion(release);
    return v && compareVersions(v, target) <= 0 && (!known || compareVersions(v, previous) > 0 || v === target);
  }).sort((a, b) => compareVersions(releaseVersion(a)!, releaseVersion(b)!))
    .map((release) => `${release.tag_name}: https://github.com/${RELEASE_REPOSITORY}/releases/tag/${release.tag_name}\n${release.body || "Release notes are missing; review this release before updating."}`)
    .join("\n\n");
}
