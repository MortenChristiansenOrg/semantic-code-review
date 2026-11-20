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
  AttachmentQuery,
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
  RequestFields,
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

/** Every parameter of a query, in any branch, each possibly undefined: a parameter
 * added to or renamed in the protocol fails the typecheck where a builder lists them. */
type QueryFields<Q> = RequestFields<Q>;

/** A POST body as its protocol request type with every field listed, optional ones
 * possibly undefined, so a field added to the protocol, optional or not, fails the
 * typecheck where a builder lists them. Undefined fields are not sent. */
type Body<T> = T & RequestFields<T>;

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

// Each builder below rebuilds its body field by field as a Body of the protocol
// request type, so adding, renaming or removing a request field fails the typecheck here.
function postJson<T>(path: string, body: object): Promise<JsonResponse<T>> {
  return request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) as Promise<JsonResponse<T>>;
}

/* ---- review session ---------------------------------------------------- */
export const getReviewState = () => getJson<ReviewStateResponse>("/api/review-state");
export const saveReviewState = ({ reviewId, generation, changes }: ReviewStatePatchRequest) =>
  postJson<ReviewStateResponse>("/api/review-state", { reviewId, generation, changes } satisfies Body<ReviewStatePatchRequest>);
export const getRevision = () => getJson<RevisionResponse>("/api/revision");
export const getImplementation = () => getJson<ImplementationResponse>("/api/implementation");
export const refreshRemote = () => postJson<RemoteRefreshResponse>("/api/remote/refresh", {});
export const resolveDraftSnapshots = ({ notes }: DraftSnapshotsRequest) =>
  postJson<DraftSnapshotsResponse>("/api/draft-snapshots", { notes } satisfies Body<DraftSnapshotsRequest>);

/* ---- listening agent --------------------------------------------------- */
export const stopAgent = () => postJson<AgentControlResponse>("/api/agent/stop", {});
export const respondToAgent = ({ requestId, body }: AgentRespondRequest) =>
  postJson<AgentControlResponse>("/api/agent/respond", { requestId, body } satisfies Body<AgentRespondRequest>);

/* ---- file content ------------------------------------------------------ */
export function getDiff({ stage, path, base, head, mode, offset, side, line }: DiffQuery): Promise<JsonResponse<DiffResponse>> {
  const query: QueryFields<DiffQuery> = { stage, path, base, head, mode, offset, side, line };
  const params = new URLSearchParams(definedEntries(query));
  return getJson<DiffResponse>(`/api/diff?${params}`);
}

/** URL of a file's complete content; with a target, of a raw resource next to it. */
export function fileContentUrl({ stage, path, base, head, target, raw, image }: FileContentQuery, hash = ""): string {
  const query: QueryFields<FileContentQuery> = { stage, path, base, head, target, raw, image };
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
const approvalEndpoint = ({ stageId, nodeId, path, baseRevision, headRevision, fileRevision, ownership }: ApprovalEndpoint): ApprovalEndpoint =>
  ({ stageId, nodeId, path, baseRevision, headRevision, fileRevision, ownership }) satisfies Body<ApprovalEndpoint>;
export const captureApprovalSnapshot = (endpoint: ApprovalEndpoint) =>
  postJson<ApprovalSnapshotResponse>("/api/approval-snapshots", approvalEndpoint(endpoint));
export const compareApproval = ({ snapshotId, offset, mode, scope, ...endpoint }: ApprovalComparisonRequest) =>
  postJson<ApprovalComparisonResponse>("/api/approval-comparison", { ...approvalEndpoint(endpoint), snapshotId, offset, mode, scope } satisfies Body<ApprovalComparisonRequest>);

/* ---- evidence and attachments ------------------------------------------ */
export function evidenceUrl({ stage, item, index }: EvidenceQuery): string {
  return apiUrl("/api/evidence", { stage, item, index } satisfies QueryFields<EvidenceQuery>).href;
}

/** Loads a URL from evidenceUrl. */
export const getEvidence = (url: string) => request(url);

export function attachmentUrl(id: string, preview = false): string {
  return apiUrl(`/api/attachments/${encodeURIComponent(id)}`, { preview: preview ? "1" : undefined } satisfies QueryFields<AttachmentQuery>).href;
}

export const uploadAttachment = ({ filename, mediaType, data }: AttachmentUploadRequest) =>
  postJson<AttachmentUploadResponse>("/api/attachments", { filename, mediaType, data } satisfies Body<AttachmentUploadRequest>);

/* ---- feedback ---------------------------------------------------------- */
export const exportFeedback = ({ implementationId, notes, replies }: FeedbackExportRequest) =>
  postJson<FeedbackExportResponse>("/api/feedback/export", { implementationId, notes, replies } satisfies Body<FeedbackExportRequest>);
export const threadAction = (kind: ThreadActionKind, { implementationId, threadId, body, attachments, clientId }: ThreadActionRequest) =>
  postJson<ThreadActionResponse>(`/api/feedback/${kind}`, { implementationId, threadId, body, attachments, clientId } satisfies Body<ThreadActionRequest>);

/* ---- saved reviews ----------------------------------------------------- */
export const getReviews = () => getJson<ReviewsResponse>("/api/reviews");
const reviewTarget = ({ reviewId, generation }: ReviewTarget): ReviewTarget => ({ reviewId, generation }) satisfies Body<ReviewTarget>;
const storageAction = ({ fingerprint, ...target }: ReviewStorageActionRequest): ReviewStorageActionRequest =>
  ({ ...reviewTarget(target), fingerprint }) satisfies Body<ReviewStorageActionRequest>;
export const inspectReviewStorage = (target: ReviewTarget) => postJson<ReviewStorageResponse>("/api/reviews/storage", reviewTarget(target));
export const deleteReviewData = (action: ReviewStorageActionRequest) => postJson<ReviewDeleteResponse>("/api/reviews/delete", storageAction(action));
export const cleanUnusedReviewData = (action: ReviewStorageActionRequest) => postJson<ReviewCleanResponse>("/api/reviews/clean-unused", storageAction(action));
export const setReviewCompletion = ({ completed, expectedCompletedAt, ...target }: ReviewCompletionRequest) =>
  postJson<OkResponse>("/api/reviews/completion", { ...reviewTarget(target), completed, expectedCompletedAt } satisfies Body<ReviewCompletionRequest>);
export const openReview = (target: ReviewOpenRequest) => postJson<ReviewOpenResponse>("/api/reviews/open", reviewTarget(target) satisfies Body<ReviewOpenRequest>);
