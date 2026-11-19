/* The only module that issues requests to the review server. Every request,
   including URLs the page hands to the browser for images, links and media,
   carries the review scope from here, so request credentials have one home. */
import type {
  AgentControlResponse,
  AgentRespondRequest,
  ApprovalComparisonRequest,
  ApprovalComparisonResponse,
  ApprovalEndpoint,
  ApprovalSnapshotResponse,
  AttachmentUploadRequest,
  AttachmentUploadResponse,
  DiffQuery,
  DiffResponse,
  DraftSnapshotsRequest,
  DraftSnapshotsResponse,
  EvidenceQuery,
  FeedbackExportRequest,
  FeedbackExportResponse,
  FileContentQuery,
  FileContentResponse,
  ImplementationResponse,
  OkResponse,
  RemoteRefreshResponse,
  ReviewCleanResponse,
  ReviewCompletionRequest,
  ReviewDeleteResponse,
  ReviewOpenRequest,
  ReviewOpenResponse,
  ReviewsResponse,
  ReviewStatePatchRequest,
  ReviewStateResponse,
  ReviewStorageActionRequest,
  ReviewStorageResponse,
  ReviewTarget,
  RevisionResponse,
  ThreadActionKind,
  ThreadActionRequest,
  ThreadActionResponse,
} from "../../scripts/src/shared/viewer-protocol";

/** A fetch response whose JSON body has a known shape. */
export interface JsonResponse<T> extends Response {
  json(): Promise<T>;
}

let reviewId: string | undefined;
let generation: string | undefined;

/** Scopes every later request to one review session. */
export function configureApi(scope: { reviewId?: string; generation?: string }): void {
  reviewId = scope.reviewId;
  generation = scope.generation;
}

// Only this viewer's own server receives the review scope.
function scoped(url: URL): URL {
  if (reviewId && url.origin === window.location.origin && url.pathname.startsWith("/api/")) {
    url.searchParams.set("review", reviewId);
    url.searchParams.set("generation", generation || "");
  }
  return url;
}

type Query = Record<string, string | undefined>;

function definedEntries(query: Query): [string, string][] {
  return Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined);
}

function apiUrl(path: string, query: Query = {}): URL {
  const url = new URL(path, window.location.href);
  for (const [key, value] of definedEntries(query)) url.searchParams.set(key, value);
  return scoped(url);
}

/** Issues one request. Nothing else in the page calls fetch. */
function request(input: string, init?: RequestInit): Promise<Response> {
  return window.fetch(scoped(new URL(input, window.location.href)).href, init);
}

function getJson<T>(input: string): Promise<JsonResponse<T>> {
  return request(input, { cache: "no-store" }) as Promise<JsonResponse<T>>;
}

function postJson<T>(path: string, body: unknown): Promise<JsonResponse<T>> {
  return request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) as Promise<JsonResponse<T>>;
}

/* ---- review session ---------------------------------------------------- */
export const getReviewState = () => getJson<ReviewStateResponse>("/api/review-state");
export const saveReviewState = (body: ReviewStatePatchRequest) => postJson<ReviewStateResponse>("/api/review-state", body);
export const getRevision = () => getJson<RevisionResponse>("/api/revision");
export const getImplementation = () => getJson<ImplementationResponse>("/api/implementation");
export const refreshRemote = () => postJson<RemoteRefreshResponse>("/api/remote/refresh", {});
export const resolveDraftSnapshots = (body: DraftSnapshotsRequest) => postJson<DraftSnapshotsResponse>("/api/draft-snapshots", body);

/* ---- listening agent --------------------------------------------------- */
export const stopAgent = () => postJson<AgentControlResponse>("/api/agent/stop", {});
export const respondToAgent = (body: AgentRespondRequest) => postJson<AgentControlResponse>("/api/agent/respond", body);

/* ---- file content ------------------------------------------------------ */
export function getDiff(query: DiffQuery): Promise<JsonResponse<DiffResponse>> {
  const params = new URLSearchParams(definedEntries(query));
  return getJson<DiffResponse>(`/api/diff?${params}`);
}

/** URL of a file's complete content; with a target, of a raw resource next to it. */
export function fileContentUrl(query: FileContentQuery, hash = ""): string {
  const url = apiUrl("/api/file-content", query);
  url.hash = hash;
  return url.href;
}

/** A `/api/file-content` URL that answers with JSON: no target and not raw. */
export type FileContentJsonUrl = string & { readonly fileContentJson: true };

/** URL of a file's complete content as JSON; also the key of its cached preview. */
export function fileContentJsonUrl({ stage, path, base, head }: Pick<FileContentQuery, "stage" | "path" | "base" | "head">): FileContentJsonUrl {
  // Copy only these fields: a full query's target or raw flag would ask for bytes.
  return fileContentUrl({ stage, path, base, head }) as FileContentJsonUrl;
}

/** Loads a file's complete content as JSON. */
export const getFileContent = (url: FileContentJsonUrl) => request(url) as Promise<JsonResponse<FileContentResponse>>;

/* ---- approvals --------------------------------------------------------- */
export const captureApprovalSnapshot = (body: ApprovalEndpoint) => postJson<ApprovalSnapshotResponse>("/api/approval-snapshots", body);
export const compareApproval = (body: ApprovalComparisonRequest) => postJson<ApprovalComparisonResponse>("/api/approval-comparison", body);

/* ---- evidence and attachments ------------------------------------------ */
export function evidenceUrl(query: EvidenceQuery): string {
  return apiUrl("/api/evidence", query).href;
}

/** Loads a URL from evidenceUrl. */
export const getEvidence = (url: string) => request(url);

export function attachmentUrl(id: string, preview = false): string {
  return apiUrl(`/api/attachments/${encodeURIComponent(id)}`, { preview: preview ? "1" : undefined }).href;
}

export const uploadAttachment = (body: AttachmentUploadRequest) => postJson<AttachmentUploadResponse>("/api/attachments", body);

/* ---- feedback ---------------------------------------------------------- */
export const exportFeedback = (body: FeedbackExportRequest) => postJson<FeedbackExportResponse>("/api/feedback/export", body);
export const threadAction = (kind: ThreadActionKind, body: ThreadActionRequest) =>
  postJson<ThreadActionResponse>(`/api/feedback/${kind}`, body);

/* ---- saved reviews ----------------------------------------------------- */
export const getReviews = () => getJson<ReviewsResponse>("/api/reviews");
export const inspectReviewStorage = (body: ReviewTarget) => postJson<ReviewStorageResponse>("/api/reviews/storage", body);
export const deleteReviewData = (body: ReviewStorageActionRequest) => postJson<ReviewDeleteResponse>("/api/reviews/delete", body);
export const cleanUnusedReviewData = (body: ReviewStorageActionRequest) => postJson<ReviewCleanResponse>("/api/reviews/clean-unused", body);
export const setReviewCompletion = (body: ReviewCompletionRequest) => postJson<OkResponse>("/api/reviews/completion", body);
export const openReview = (body: ReviewOpenRequest) => postJson<ReviewOpenResponse>("/api/reviews/open", body);
