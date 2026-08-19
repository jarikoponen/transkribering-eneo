// All requests go to same-origin /api/* — Next rewrites these to the backend.
// The backend in turn proxies /api/eneo/* to Eneo with X-API-Key.

import {
  resolveRuntimeUploadIdleTimeoutMs,
  resolveRuntimeUploadInitialTimeoutMs,
} from "./upload";

export type Json = Record<string, unknown>;

export class ApiError extends Error {
  status: number;
  code?: string;
  body: unknown;

  constructor(status: number, message: string, body: unknown, code?: string) {
    super(message);
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

/**
 * FastAPI svarar 422 med `{ detail: [{ loc, msg, type }, ...] }`. Eneos
 * run-/review-request bodies avvisar okända fält, så den här formen dyker upp
 * så fort appen och specen glidit isär — visa den i klartext.
 */
function formatValidationDetail(detail: unknown[]): string | undefined {
  const parts = detail
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const d = item as { loc?: unknown; msg?: unknown };
      const loc = Array.isArray(d.loc) ? d.loc.join(".") : undefined;
      const msg = typeof d.msg === "string" ? d.msg : undefined;
      if (!msg) return null;
      return loc ? `${loc}: ${msg}` : msg;
    })
    .filter((x): x is string => !!x);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  let code: string | undefined;
  let detail: string | undefined;
  try {
    body = await res.json();
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (typeof b.code === "string") code = b.code;
      // Vår egen proxy svarar `{ error: "upstream_unreachable", detail: "..." }`.
      // Eneo svarar `{ code: "...", detail: "..." }`. Båda mappas till `code`.
      else if (typeof b.error === "string") code = b.error;
      if (typeof b.detail === "string") detail = b.detail;
      else if (typeof b.message === "string") detail = b.message;
      else if (Array.isArray(b.detail)) detail = formatValidationDetail(b.detail);
    }
  } catch {
    // ignore — body stays null
  }
  const msg = detail || code || `HTTP ${res.status}`;
  return new ApiError(res.status, msg, body, code);
}

// ---------- Space context (för flerspace-läge med olika API-nycklar) ----------
// Backend mappar X-Space-Id-header → rätt API-nyckel. Vi sätter contexten
// vid mount av flödesdetaljvyn så att alla efterföljande anrop använder rätt nyckel.

let currentSpaceId: string | null = null;

export function setSpaceContext(spaceId: string | null): void {
  currentSpaceId = spaceId;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  opts: { spaceId?: string | null } = {},
): Promise<T> {
  const effectiveSpaceId = opts.spaceId ?? currentSpaceId;
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(effectiveSpaceId ? { "X-Space-Id": effectiveSpaceId } : {}),
      ...init.headers,
    },
  });

  if (!res.ok) {
    // Bounce to login bara om backend explicit signalerar att VÅR session
    // har gått ut (X-Auth-Required: session). En vanlig 401 från Eneo
    // (t.ex. ogiltig API-nyckel) får INTE trigga redirect — då hamnar vi
    // i en login-loop. Felet får i stället bubbla upp och visas i UI:t.
    if (
      res.status === 401 &&
      res.headers.get("X-Auth-Required") === "session" &&
      typeof window !== "undefined" &&
      !path.startsWith("/api/auth/") &&
      window.location.pathname !== "/"
    ) {
      window.location.replace("/");
    }
    throw await parseError(res);
  }

  if (res.status === 204) return undefined as T;

  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}

// ---------- Config ----------

export interface AppConfig {
  demo_space_id: string | null;
  demo_space_name: string | null;
  /** Lista över alla konfigurerade spaces. Tom = inget hårdkodat space (frontend visar väljare). */
  demo_space_ids?: string[];
}

export async function getConfig() {
  return request<AppConfig>("/api/config");
}

// ---------- Auth ----------

export async function login(accessCode: string) {
  return request<{ ok: true }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ access_code: accessCode }),
  });
}

export async function logout() {
  return request<{ ok: true }>("/api/auth/logout", { method: "POST" });
}

export async function authStatus() {
  return request<{ authenticated: boolean }>("/api/auth/status");
}

// ---------- Eneo ----------

export interface SpaceSparse {
  id: string;
  name: string;
  description?: string | null;
  personal?: boolean;
}

export interface PaginatedResponse<T> {
  items: T[];
  count?: number;
  total_count?: number;
}

export interface FlowSparsePublic {
  id: string;
  name: string;
  description?: string | null;
  published_version?: number | null;
  is_published?: boolean;
}

export interface FormField {
  name: string;
  label?: string | null;
  type?: string;
  required?: boolean;
  options?: unknown;
  order?: number;
  description?: string;
  default?: unknown;
}

export interface RunContractStepInput {
  step_id: string;
  step_order?: number;
  label?: string;
  description?: string;
  required?: boolean;
  input_format?: string;
  max_files?: number;
  max_file_size_bytes?: number;
  accepted_mimetypes?: string[];
}

export interface FlowRuntimeUploadPolicy {
  min_timeout_seconds: number;
  seconds_per_mebibyte: number;
  max_timeout_seconds: number;
  idle_timeout_seconds: number;
}

/** Publicerat terminalt output-kontrakt (nytt i refactor-flows). */
export interface FlowFinalOutputContract {
  step_id: string;
  step_order: number;
  label?: string | null;
  output_type: FlowOutputType;
  output_mode: FlowOutputMode;
  delivery: FlowOutputDelivery;
  output_contract?: Json | null;
}

export interface FlowReviewStepContract {
  step_id: string;
  step_order: number;
  label?: string | null;
  review_mode?: FlowStepReviewMode | null;
  output_type?: FlowOutputType | null;
  output_contract?: Json | null;
  expires_after_seconds?: number | null;
}

export interface RunContract {
  flow_id: string;
  published_flow_version: number;
  form_fields?: FormField[];
  steps_requiring_input?: RunContractStepInput[];
  runtime_upload_policy?: FlowRuntimeUploadPolicy | null;
  /** Nytt: säger direkt om flödet slutar i text, JSON eller en genererad fil. */
  final_output?: FlowFinalOutputContract | null;
  steps_requiring_review?: FlowReviewStepContract[];
  aggregate_max_files?: number | null;
  template_readiness?: Json[];
}

export interface FlowPublished {
  id: string;
  name: string;
  description?: string | null;
  published_version: number;
}

export interface FilePublic {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  transcription?: string | null;
}

export interface ResultFile {
  file_id: string;
  name?: string;
  mimetype?: string | null;
  size?: number;
  file_type?: FileType | string;
  step_id?: string;
  step_order?: number;
  attempt_no?: number;
  ordinal?: number;
  source?: string;
  checksum?: string;
  /** "available" | "content_purged" | ... — signera bara nedladdning när den är available. */
  availability?: string;
}

/** True om filen fortfarande går att ladda ner. */
export function isResultFileDownloadable(file: ResultFile): boolean {
  return file.availability == null || file.availability === "available";
}

// Typat terminalresultat. Ersätter det borttagna `output_payload_json`.
export interface FlowRunInlineTextResult {
  kind: "inline_text";
  text: string;
}
export interface FlowRunFileBackedTextResult {
  kind: "file_backed_text";
  /** Avkortad, icke-auktoritativ prefix — hela texten ligger i `file`. */
  preview: string;
  file: ResultFile;
}
export interface FlowRunStructuredResult {
  kind: "structured";
  value: unknown;
  output_contract?: Json | null;
}
export interface FlowRunArtifactResult {
  kind: "artifact";
  files: ResultFile[];
}
export interface FlowRunOutboundHttpResult {
  kind: "outbound_http";
  delivery_status: "delivered";
}

export type FlowRunResult =
  | FlowRunInlineTextResult
  | FlowRunFileBackedTextResult
  | FlowRunStructuredResult
  | FlowRunArtifactResult
  | FlowRunOutboundHttpResult;

/** Typat körningsfel. Ersätter det borttagna `error_message`. */
export interface FlowRunError {
  schema_version?: number;
  code: string;
  message: string;
  source?: string | null;
  step_id?: string | null;
  step_order?: number | null;
  retryable: boolean;
  details?: Json | null;
}

export interface FlowRunPublic {
  id: string;
  flow_id: string;
  status: string; // se FlowRunStatus — behåll string för forward-compat
  /** Typat slutresultat. Null tills körningen lyckats. */
  result?: FlowRunResult | null;
  /** Alla nedladdningsbara filer från nuvarande försök, inte bara slutresultatets. */
  result_files?: ResultFile[];
  error?: FlowRunError | null;
  created_at?: string;
  updated_at?: string;
  started_at?: string;
  finished_at?: string;
  flow_version?: number;
  trace_id?: string;
  revision?: number;
  cancelled_at?: string | null;
  input_payload_json?: Json | null;
  job_id?: string | null;
}

/**
 * Plockar ut text att visa ur det typade resultatet.
 * `file_backed_text` ger bara en preview — hela texten hämtas via result_files.
 */
export function runResultText(
  run: FlowRunPublic,
): { text: string; truncated: boolean } | null {
  const r = run.result;
  if (!r) return null;
  if (r.kind === "inline_text") {
    return r.text ? { text: r.text, truncated: false } : null;
  }
  if (r.kind === "file_backed_text") {
    return r.preview ? { text: r.preview, truncated: true } : null;
  }
  if (r.kind === "structured") {
    const v = r.value;
    if (typeof v === "string") return { text: v, truncated: false };
    if (v == null) return null;
    return {
      text: "```json\n" + JSON.stringify(v, null, 2) + "\n```",
      truncated: false,
    };
  }
  return null;
}

/** Felmeddelande för en misslyckad körning. */
export function runErrorMessage(run: FlowRunPublic): string | null {
  return run.error?.message ?? null;
}

/** Filer som hör till slutresultatet, med fallback till alla result_files. */
export function runResultFiles(run: FlowRunPublic): ResultFile[] {
  const r = run.result;
  if (r?.kind === "artifact") return r.files ?? [];
  if (r?.kind === "file_backed_text") return r.file ? [r.file] : [];
  return run.result_files ?? [];
}

export interface FlowRunStep {
  id: string;
  step_id: string;
  /** Saknas i ny spec — härled från GraphResponse.nodes vid behov. */
  step_name?: string;
  /** Saknas i ny spec — härled från GraphResponse.nodes vid behov. */
  step_label?: string;
  step_order?: number;
  status: string; // se FlowStepResultStatus
  started_at?: string;
  completed_at?: string;
  finished_at?: string;
  [k: string]: unknown;
}

// ---------- Nya typer för refaktorerade Eneo-flows ----------

export type FlowRunStatus =
  | "queued"
  | "running"
  | "awaiting_review"
  | "completed"
  | "failed"
  | "cancelled";

export type FlowStepResultStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type FlowStepReviewMode = "view" | "edit";

export type FlowOutputType = "text" | "json" | "pdf" | "docx";
export type FlowOutputMode =
  | "pass_through"
  | "http_post"
  | "transcribe_only"
  | "template_fill";
export type FlowOutputDelivery = "payload" | "artifact" | "outbound_http";
export type FlowRuntimeInputFormat = "document" | "audio" | "file";
export type FileType = "text" | "image" | "audio" | "document";
export type ContentDisposition = "attachment" | "inline";

export type FlowRunReviewCheckpointState =
  | "awaiting_review"
  | "edited"
  | "approved"
  | "rejected"
  | "resumed"
  | "cancelled"
  | "expired";

export interface OffsetPaginatedResponse<T> {
  items: T[];
  has_more: boolean;
  count: number;
}

export interface FlowRunReviewCheckpointPublic {
  id: string;
  flow_id: string;
  flow_run_id: string;
  step_id: string;
  step_order: number;
  attempt_no: number;
  state: FlowRunReviewCheckpointState;
  revision: number;
  schema_version: number;
  original_payload_json?: Json | null;
  current_payload_json?: Json | null;
  step_label?: string | null;
  review_mode?: FlowStepReviewMode | null;
  output_type?: FlowOutputType | null;
  step_snapshot_available?: boolean;
  output_contract?: Json | null;
  next_step_ids?: string[] | null;
  approved_at?: string | null;
  rejected_at?: string | null;
  resumed_at?: string | null;
  cancelled_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewEditRequest {
  expected_checkpoint_revision: number;
  /**
   * Själva det korrigerade stegresultatet — inte en payload-envelope.
   * Sträng för text-steg, objekt/array för json-steg.
   */
  edited_value: string | Json | unknown[];
}

export interface ReviewApproveRequest {
  expected_checkpoint_revision: number;
}
export interface ReviewRejectRequest {
  expected_checkpoint_revision: number;
  reason: string;
}
export interface ReviewResumeRequest {
  expected_checkpoint_revision: number;
}
export interface ReviewResumeResponse {
  checkpoint: FlowRunReviewCheckpointPublic;
  run: FlowRunPublic;
}

export function isReviewCheckpointApproved(
  checkpoint: FlowRunReviewCheckpointPublic | null | undefined,
): checkpoint is FlowRunReviewCheckpointPublic {
  return checkpoint?.state === "approved" || checkpoint?.state === "resumed";
}

export function reviewResumeIdempotencyKey(
  runId: string,
  checkpointId: string,
): string {
  return `review-resume:${runId}:${checkpointId}`;
}

export interface UploadProgress {
  loaded: number;
  total: number | null;
  percent: number | null;
}

export type RuntimeUploadTimeoutReason =
  | "not_started"
  | "stalled"
  | "server_not_responding";

export interface RuntimeUploadTimeoutEvent {
  reason: RuntimeUploadTimeoutReason;
  timeoutMs: number;
}

interface UploadRequestOptions {
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  onTimeout?: (event: RuntimeUploadTimeoutEvent) => void;
  runtimeUploadPolicy?: FlowRuntimeUploadPolicy | null;
}

function formatTimeoutReason(reason: RuntimeUploadTimeoutReason): string {
  switch (reason) {
    case "not_started":
      return "Uppladdningen startade inte i tid.";
    case "stalled":
      return "Uppladdningen stannade utan nätverksprogress.";
    case "server_not_responding":
      return "Filen skickades, men servern svarade inte i tid.";
  }
}

function parseXhrError(xhr: XMLHttpRequest): ApiError {
  let body: unknown = null;
  let code: string | undefined;
  let detail: string | undefined;
  try {
    body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (typeof b.code === "string") code = b.code;
      // Vår uploadproxy svarar `{ error, detail }` i stället för Eneos `{ code, message }`.
      else if (typeof b.error === "string") code = b.error;
      if (typeof b.detail === "string") detail = b.detail;
      else if (typeof b.message === "string") detail = b.message;
      else if (Array.isArray(b.detail)) detail = formatValidationDetail(b.detail);
    }
  } catch {
    body = xhr.responseText || null;
  }
  return new ApiError(xhr.status, detail || code || `HTTP ${xhr.status}`, body, code);
}

function requestMultipartWithProgress<T>(
  path: string,
  formData: FormData,
  opts: UploadRequestOptions & { fileSizeBytes: number } = {
    fileSizeBytes: 0,
  },
): Promise<T> {
  const effectiveSpaceId = currentSpaceId;
  const initialTimeoutMs = resolveRuntimeUploadInitialTimeoutMs(
    opts.fileSizeBytes,
    opts.runtimeUploadPolicy,
  );
  const idleTimeoutMs = resolveRuntimeUploadIdleTimeoutMs(opts.runtimeUploadPolicy);

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let lastUploadedBytes = 0;
    let settled = false;

    const clearScheduledTimeout = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = null;
    };

    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearScheduledTimeout();
      reject(error);
    };

    const scheduleTimeout = (
      timeoutMs: number,
      reason: RuntimeUploadTimeoutReason,
    ) => {
      clearScheduledTimeout();
      timeoutId = setTimeout(() => {
        opts.onTimeout?.({ reason, timeoutMs });
        xhr.abort();
        rejectOnce(new ApiError(408, formatTimeoutReason(reason), null, reason));
      }, timeoutMs);
    };

    scheduleTimeout(initialTimeoutMs, "not_started");

    xhr.upload.onprogress = (event) => {
      if (event.loaded <= lastUploadedBytes) return;
      lastUploadedBytes = event.loaded;
      const total = event.lengthComputable && event.total > 0 ? event.total : null;
      const percent = total ? Math.round((event.loaded / total) * 100) : null;
      opts.onProgress?.({ loaded: event.loaded, total, percent });

      const uploadComplete = total != null && event.loaded >= total;
      scheduleTimeout(
        uploadComplete ? Math.max(initialTimeoutMs, idleTimeoutMs) : idleTimeoutMs,
        uploadComplete ? "server_not_responding" : "stalled",
      );
    };

    xhr.onload = () => {
      if (settled) return;
      settled = true;
      clearScheduledTimeout();
      if (xhr.status >= 200 && xhr.status < 300) {
        if (xhr.status === 204 || !xhr.responseText) {
          resolve(undefined as T);
          return;
        }
        const ctype = xhr.getResponseHeader("content-type") || "";
        try {
          resolve(
            ctype.includes("application/json")
              ? (JSON.parse(xhr.responseText) as T)
              : (xhr.responseText as T),
          );
        } catch {
          reject(
            new ApiError(
              xhr.status,
              "Servern svarade med ogiltig JSON.",
              xhr.responseText,
              "invalid_json_response",
            ),
          );
        }
        return;
      }
      reject(parseXhrError(xhr));
    };

    xhr.onerror = () => {
      rejectOnce(
        new ApiError(
          0,
          "Nätverksfel vid uppladdning. Kontrollera anslutningen och försök igen.",
          null,
          "network_error",
        ),
      );
    };

    xhr.onabort = () => {
      rejectOnce(
        new ApiError(0, "Uppladdningen avbröts.", null, "upload_aborted"),
      );
    };

    opts.signal?.addEventListener(
      "abort",
      () => {
        xhr.abort();
      },
      { once: true },
    );

    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader(
      "X-Upload-Timeout-Seconds",
      String(Math.ceil(initialTimeoutMs / 1000)),
    );
    if (effectiveSpaceId) xhr.setRequestHeader("X-Space-Id", effectiveSpaceId);
    xhr.send(formData);
  });
}

function stableSortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSortJson);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = stableSortJson((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ---------- API-anrop ----------

export async function listSpaces(opts: { spaceId?: string } = {}) {
  return request<PaginatedResponse<SpaceSparse>>(
    "/api/eneo/spaces/?include_personal=true",
    {},
    opts,
  );
}

/** Hämtar en specifik space direkt. Funkar även när /spaces/-listning är tom (scope-begränsade keys). */
export async function getSpace(spaceId: string, opts: { spaceId?: string } = {}) {
  return request<SpaceSparse>(
    `/api/eneo/spaces/${spaceId}/`,
    {},
    { spaceId: opts.spaceId ?? spaceId },
  );
}

export async function listFlows(
  spaceId: string,
  limit = 50,
  offset = 0,
  opts: { spaceId?: string } = {},
) {
  const qs = new URLSearchParams({
    space_id: spaceId,
    limit: String(limit),
    offset: String(offset),
  });
  // Default: X-Space-Id matchar space_id-paramen om inget annat angetts.
  const effective = { spaceId: opts.spaceId ?? spaceId };
  return request<OffsetPaginatedResponse<FlowSparsePublic>>(
    `/api/eneo/flows/?${qs.toString()}`,
    {},
    effective,
  );
}

export async function getPublishedFlow(flowId: string) {
  return request<FlowPublished>(`/api/eneo/flows/${flowId}/published/`);
}

export async function getRunContract(
  flowId: string,
  opts: { spaceId?: string } = {},
) {
  return request<RunContract>(
    `/api/eneo/flows/${flowId}/run-contract/`,
    {},
    opts,
  );
}

// input_format för det första steget som kräver input (lägst step_order).
// "audio" → mikrofon, "document"/"file"/"image" → dokument/fil.
export function firstInputFormat(contract: RunContract): string | null {
  const steps = [...(contract.steps_requiring_input ?? [])].sort(
    (a, b) => (a.step_order ?? 0) - (b.step_order ?? 0),
  );
  return steps[0]?.input_format?.toLowerCase() ?? null;
}

// ---------- Flow graph ----------

export interface FlowGraphNode {
  id: string;
  label: string;
  type: string; // "input" | "output" | "llm" | ...
  step_order: number | null;
  input_source: string | null;
  input_type: string | null;
  output_type: string | null; // "text" | "json" | "docx" | "pdf" | ...
  output_mode: string | null;
}

export interface FlowGraphEdge {
  source: string;
  target: string;
  kind: string; // "flow_input" | "previous_step" | "flow_output" | "input_bindings.X"
  label: string | null;
}

export interface FlowGraph {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
}

export async function getFlowGraph(flowId: string) {
  return request<FlowGraph>(`/api/eneo/flows/${flowId}/graph/`);
}

/** Returnerar `output_type` för det steg som matar flow_output-edgen (t.ex. "docx", "text"). */
export function getFlowOutputType(graph: FlowGraph): string | null {
  const flowOutputEdge = graph.edges.find((e) => e.kind === "flow_output");
  if (!flowOutputEdge) return null;
  const lastStep = graph.nodes.find((n) => n.id === flowOutputEdge.source);
  return lastStep?.output_type ?? null;
}

/**
 * Output-typ för flödet. Nya run-kontraktet svarar direkt via `final_output`;
 * grafen är kvar som fallback för äldre/ofullständiga svar.
 */
export function resolveFlowOutputType(
  contract: RunContract | null | undefined,
  graph: FlowGraph | null | undefined,
): string | null {
  return (
    contract?.final_output?.output_type ??
    (graph ? getFlowOutputType(graph) : null)
  );
}

const TEXTUAL_OUTPUT_TYPES = new Set(["text", "markdown", "json"]);

/** True om output kan renderas som text/markdown i UI; false för binära artefakter (DOCX/PDF/...). */
export function isTextualOutput(outputType: string | null | undefined): boolean {
  if (!outputType) return true; // default: visa som text om vi inte vet
  return TEXTUAL_OUTPUT_TYPES.has(outputType.toLowerCase());
}

export async function startRun(
  flowId: string,
  body: Json,
  idempotencyKey: string,
) {
  return request<FlowRunPublic>(`/api/eneo/flows/${flowId}/runs/`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
  });
}

export async function deriveRunIdempotencyKey(params: {
  flowId: string;
  expectedFlowVersion: number;
  body: Json;
}): Promise<string> {
  const normalized = stableSortJson({
    flow_id: params.flowId,
    expected_flow_version: params.expectedFlowVersion,
    body: params.body,
  });
  return `flow-run:${await sha256Hex(JSON.stringify(normalized))}`;
}

export async function getRun(flowId: string, runId: string) {
  return request<FlowRunPublic>(`/api/eneo/flows/${flowId}/runs/${runId}/`);
}

export async function getRunSteps(flowId: string, runId: string) {
  // Eneo returns a bare list here, not a paginated wrapper.
  const res = await request<FlowRunStep[] | PaginatedResponse<FlowRunStep>>(
    `/api/eneo/flows/${flowId}/runs/${runId}/steps/`,
  );
  if (Array.isArray(res)) return res;
  return res.items ?? [];
}

/**
 * Eneo mintar signerade URL:er med `http://` (den 301:ar till https, men en
 * browser på en https-sida blockerar anropet som mixed content innan det ens
 * skickas). Uppgradera schemat när vi själva körs över https.
 */
export function upgradeSignedUrlScheme(url: string): string {
  if (typeof window === "undefined") return url;
  if (window.location.protocol !== "https:") return url;
  if (!url.startsWith("http://")) return url;
  return `https://${url.slice("http://".length)}`;
}

export async function getArtifactSignedUrl(
  flowId: string,
  runId: string,
  fileId: string,
  expiresInSeconds = 3600,
) {
  const res = await request<{ url: string; expires_at: number }>(
    `/api/eneo/flows/${flowId}/runs/${runId}/artifacts/${fileId}/signed-url/`,
    {
      method: "POST",
      body: JSON.stringify({ expires_in: expiresInSeconds }),
    },
  );
  return { ...res, url: upgradeSignedUrlScheme(res.url) };
}

export async function uploadStepRuntimeFile(
  flowId: string,
  stepId: string,
  file: Blob,
  filename: string,
  opts: UploadRequestOptions & { contentType?: string | null } = {},
) {
  // Eneo avvisar numera "missing, generic, or unsupported declared types" på
  // multipart-delen — även när innehållet går att sniffa. Vi deklarerar därför
  // alltid en exakt sträng ur stegets accepted_mimetypes.
  const declared = opts.contentType?.trim();
  const part =
    declared && declared !== file.type
      ? new Blob([file], { type: declared })
      : file;

  const fd = new FormData();
  fd.append("upload_file", part, filename);
  return requestMultipartWithProgress<FilePublic>(
    `/api/eneo/flows/${flowId}/steps/${stepId}/runtime-files/`,
    fd,
    { ...opts, fileSizeBytes: file.size },
  );
}

// --- Review checkpoints ---

export async function getActiveReviewCheckpoint(flowId: string, runId: string) {
  return request<FlowRunReviewCheckpointPublic | null>(
    `/api/eneo/flows/${flowId}/runs/${runId}/review-checkpoints/active/`,
  );
}

export async function editReviewCheckpoint(
  flowId: string,
  runId: string,
  checkpointId: string,
  body: ReviewEditRequest,
) {
  return request<FlowRunReviewCheckpointPublic>(
    `/api/eneo/flows/${flowId}/runs/${runId}/review-checkpoints/${checkpointId}/`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
}

export async function approveReviewCheckpoint(
  flowId: string,
  runId: string,
  checkpointId: string,
  body: ReviewApproveRequest,
) {
  return request<FlowRunReviewCheckpointPublic>(
    `/api/eneo/flows/${flowId}/runs/${runId}/review-checkpoints/${checkpointId}/approve/`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export async function rejectReviewCheckpoint(
  flowId: string,
  runId: string,
  checkpointId: string,
  body: ReviewRejectRequest,
) {
  return request<FlowRunReviewCheckpointPublic>(
    `/api/eneo/flows/${flowId}/runs/${runId}/review-checkpoints/${checkpointId}/reject/`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export async function resumeReviewCheckpoint(
  flowId: string,
  runId: string,
  checkpointId: string,
  body: ReviewResumeRequest,
  idempotencyKey: string,
) {
  return request<ReviewResumeResponse>(
    `/api/eneo/flows/${flowId}/runs/${runId}/review-checkpoints/${checkpointId}/resume/`,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    },
  );
}
