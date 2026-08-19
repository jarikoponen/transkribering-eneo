import type {
  FlowRuntimeUploadPolicy,
  RunContract,
  RunContractStepInput,
} from "./api";

const MEBIBYTE_BYTES = 1024 * 1024;
const FALLBACK_UPLOAD_MIN_TIMEOUT_SECONDS = 120;
const FALLBACK_UPLOAD_SECONDS_PER_MEBIBYTE = 4;
const FALLBACK_UPLOAD_MAX_TIMEOUT_SECONDS = 1800;
const FALLBACK_UPLOAD_IDLE_TIMEOUT_SECONDS = 120;

function positiveFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function resolveRuntimeUploadInitialTimeoutMs(
  fileSizeBytes: number,
  policy: FlowRuntimeUploadPolicy | null | undefined,
): number {
  const minSeconds =
    positiveFinite(policy?.min_timeout_seconds) ??
    FALLBACK_UPLOAD_MIN_TIMEOUT_SECONDS;
  const secondsPerMebibyte =
    positiveFinite(policy?.seconds_per_mebibyte) ??
    FALLBACK_UPLOAD_SECONDS_PER_MEBIBYTE;
  const maxSeconds =
    positiveFinite(policy?.max_timeout_seconds) ??
    FALLBACK_UPLOAD_MAX_TIMEOUT_SECONDS;

  const sizeMebibytes = Math.max(0, fileSizeBytes) / MEBIBYTE_BYTES;
  const estimatedSeconds = Math.ceil(sizeMebibytes * secondsPerMebibyte);
  const clampedSeconds = Math.min(
    maxSeconds,
    Math.max(minSeconds, estimatedSeconds),
  );
  return clampedSeconds * 1000;
}

export function resolveRuntimeUploadIdleTimeoutMs(
  policy: FlowRuntimeUploadPolicy | null | undefined,
): number {
  const idleSeconds =
    positiveFinite(policy?.idle_timeout_seconds) ??
    FALLBACK_UPLOAD_IDLE_TIMEOUT_SECONDS;
  return idleSeconds * 1000;
}

export function baseMimetype(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

export function isMimeAllowed(
  mime: string,
  accepted: string[] | undefined,
): boolean {
  if (!accepted || accepted.length === 0) return true;
  const normalized = mime.trim().toLowerCase();
  const base = baseMimetype(normalized);
  return accepted.some((candidate) => {
    const allowed = candidate.trim().toLowerCase();
    if (allowed === "*/*") return true;
    if (allowed.endsWith("/*")) return base.startsWith(allowed.slice(0, -1));
    return allowed === normalized || allowed === base;
  });
}

export function pickSupportedAudioMimetype(
  accepted: string[] | undefined,
  isTypeSupported: (mime: string) => boolean,
): string | null {
  const preferred = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
    "audio/mpeg",
  ];
  const candidates = [...preferred, ...(accepted ?? [])].filter(
    (mime, index, all) =>
      all.indexOf(mime) === index && isMimeAllowed(mime, accepted),
  );

  for (const mime of candidates) {
    try {
      if (isTypeSupported(mime)) return mime;
    } catch {
      // Some browser implementations throw for unknown MIME strings.
    }
  }
  return null;
}

export function extensionForAudioMime(mime: string): string {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("wav")) return "wav";
  return "bin";
}

export function isRuntimeFileInput(
  inputFormat: string | null | undefined,
): boolean {
  return ["audio", "document", "file", "image"].includes(
    inputFormat?.toLowerCase() ?? "",
  );
}

export function selectRuntimeInputStep(
  contract: RunContract | null,
): RunContractStepInput | null {
  const steps = [...(contract?.steps_requiring_input ?? [])].sort((a, b) => {
    const aOrder = a.step_order ?? Number.MAX_SAFE_INTEGER;
    const bOrder = b.step_order ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.step_id.localeCompare(b.step_id);
  });

  const fileLikeStep = steps.find((step) =>
    isRuntimeFileInput(step.input_format),
  );
  return fileLikeStep ?? steps[0] ?? null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Väljer den MIME-sträng som ska deklareras på multipart-delen vid upload.
 *
 * Eneo validerar numera den *deklarerade* typen mot stegets
 * `accepted_mimetypes` och avvisar saknade, generiska
 * (`application/octet-stream`) och icke-listade typer — även när innehållet
 * går att detektera. Vi returnerar därför alltid en exakt sträng ur listan när
 * en sådan matchar filen, annars filens egen typ.
 */
export function pickUploadMimetype(
  fileMimetype: string | null | undefined,
  accepted: string[] | undefined,
): string | null {
  const own = fileMimetype?.trim() ?? "";
  const list = (accepted ?? []).map((m) => m.trim()).filter(Boolean);
  const concreteList = list.filter((m) => !m.includes("*"));

  // Ingen lista att rätta sig efter — behåll filens egen typ om den är användbar.
  if (concreteList.length === 0) {
    return own && own !== GENERIC_MIMETYPE ? own : null;
  }

  // Exakt träff (inkl. parametrar, t.ex. "audio/webm;codecs=opus").
  const exact = concreteList.find((m) => m.toLowerCase() === own.toLowerCase());
  if (exact) return exact;

  // Samma bastyp — deklarera listans variant i stället för filens
  // (t.ex. filens "audio/webm" mot listans "audio/webm;codecs=opus").
  if (own && own !== GENERIC_MIMETYPE) {
    const base = baseMimetype(own);
    const sameBase = concreteList.find((m) => baseMimetype(m) === base);
    if (sameBase) return sameBase;
    // Filen har en tydlig typ som inte finns i listan. Ljug inte om den —
    // låt Eneo avvisa den så att felet blir begripligt.
    return own;
  }

  // Saknad eller generisk typ (vanligt för filer valda från vissa filsystem):
  // deklarera den enda tillåtna typen om steget bara accepterar en.
  return concreteList.length === 1 ? concreteList[0] : null;
}

const GENERIC_MIMETYPE = "application/octet-stream";
