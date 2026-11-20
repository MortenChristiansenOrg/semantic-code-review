/* The only module that issues requests to the review server. Every request,
   including URLs the page hands to the browser for images, links and media,
   carries the review scope from here, so request credentials have one home:
   requests send the viewer key in a header, and only the URLs of evidence,
   attachments and raw file content carry the read token. */
import { currentAccess, loseAccess, type Access } from "./access";
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
  BootstrapResponse,
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
  SessionRequest,
  SessionResponse,
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

const KEY_HEADER = "x-semantic-flow-key";
/** How long the server may stay unreachable before the page asks for a fresh link. */
const UNREACHABLE_MS = 5000;
/** Failures further apart than this belong to separate outages: the page polls
 * every second, and a poll fails at the latest after its deadline. */
const OUTAGE_GAP_MS = 5000;
/** How long a poll for a new revision may wait for its answer. */
const POLL_DEADLINE_MS = 3000;
/** How long loading a changed implementation, or the review data the page starts with, may take. */
const IMPLEMENTATION_DEADLINE_MS = 30_000;
/** How long exchanging a launch code may take. */
const SESSION_DEADLINE_MS = 10_000;

let outageSince = 0;
let lastFailure = 0;
/** Counts a request that did not reach the server. A viewer that stopped, for
 * example for an update, comes back with new secrets, so an outage that lasts
 * asks for a fresh link. Failures count only while the page still uses the key
 * they used. */
function noteUnreachable(used: Access): void {
  if (used.key !== currentAccess()?.key) return;
  const now = Date.now();
  if (!outageSince || now - lastFailure > OUTAGE_GAP_MS) outageSince = now;
  lastFailure = now;
  if (now - outageSince >= UNREACHABLE_MS) loseAccess(used);
}

/** Statuses whose responses have no body. */
const NO_BODY = new Set([101, 103, 204, 205, 304]);

/** Reads a response completely. The server is reached only once the whole body
 * arrived: a body that breaks off or stalls past the request's deadline fails
 * like a request that got no answer. */
async function readFully(response: Response): Promise<Response> {
  const body = await response.arrayBuffer();
  return new Response(NO_BODY.has(response.status) ? null : body, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}

/** Whether a response is the server's refusal of a missing or outdated key. */
async function keyRefused(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  try {
    const body: unknown = await response.clone().json();
    return Boolean(body && typeof body === "object" && "keyRequired" in body && body.keyRequired === true);
  } catch { return false; }
}

// Only these resources, which the browser loads by URL, carry the read token.
function withReadToken(url: URL): URL {
  const current = currentAccess();
  if (current && url.origin === window.location.origin) url.searchParams.set("read", current.read);
  return url;
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

/** Issues one request with the page's key. Nothing else in the page calls fetch,
 * except the launch code exchange below. */
async function request(input: string, init: RequestInit = {}): Promise<Response> {
  const current = currentAccess();
  if (!current) throw new Error("This review page needs a fresh link.");
  const url = scoped(new URL(input, window.location.href));
  const headers = new Headers(init.headers);
  if (url.origin === window.location.origin) headers.set(KEY_HEADER, current.key);
  let response: Response;
  try { response = await readFully(await window.fetch(url.href, { ...init, headers })); }
  catch (error) { noteUnreachable(current); throw error; }
  // A late answer under an older key says nothing about the current one.
  if (current.key === currentAccess()?.key) outageSince = 0;
  if (await keyRefused(response)) loseAccess(current);
  return response;
}

function getJson<T>(input: string, deadlineMs?: number): Promise<JsonResponse<T>> {
  return request(input, { cache: "no-store", signal: deadlineMs ? AbortSignal.timeout(deadlineMs) : undefined }) as Promise<JsonResponse<T>>;
}

// Each builder below rebuilds its body field by field as a Body of the protocol
// request type, so adding, renaming or removing a request field fails the typecheck here.
function postJson<T>(path: string, body: object): Promise<JsonResponse<T>> {
  return request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) as Promise<JsonResponse<T>>;
}

/* ---- page start -------------------------------------------------------- */
/** Exchanges a launch code for the secrets. It needs no key, and its refusal of a
 * spent or expired code leaves the access the page has alone. */
export const startSession = ({ code }: SessionRequest) => window.fetch(new URL("/api/session", window.location.href).href, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code } satisfies Body<SessionRequest>),
  // The deadline also covers reading the answer.
  signal: AbortSignal.timeout(SESSION_DEADLINE_MS),
}) as Promise<JsonResponse<SessionResponse>>;
export const getBootstrap = () => getJson<BootstrapResponse>("/api/bootstrap", IMPLEMENTATION_DEADLINE_MS);

/* ---- review session ---------------------------------------------------- */
export const getReviewState = () => getJson<ReviewStateResponse>("/api/review-state");
export const saveReviewState = ({ reviewId, generation, changes, saveId }: ReviewStatePatchRequest) =>
  postJson<ReviewStateResponse>("/api/review-state", { reviewId, generation, changes, saveId } satisfies Body<ReviewStatePatchRequest>);
export const getRevision = () => getJson<RevisionResponse>("/api/revision", POLL_DEADLINE_MS);
export const getImplementation = () => getJson<ImplementationResponse>("/api/implementation", IMPLEMENTATION_DEADLINE_MS);
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
  if (raw === "1") withReadToken(url);
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
  return withReadToken(apiUrl("/api/evidence", { stage, item, index } satisfies QueryFields<EvidenceQuery>)).href;
}

/** Loads a URL from evidenceUrl. */
export const getEvidence = (url: string) => request(url);

export function attachmentUrl(id: string, preview = false): string {
  return withReadToken(apiUrl(`/api/attachments/${encodeURIComponent(id)}`, { preview: preview ? "1" : undefined } satisfies QueryFields<AttachmentQuery>)).href;
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
