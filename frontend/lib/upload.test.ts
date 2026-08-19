import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  deriveRunIdempotencyKey,
  isReviewCheckpointApproved,
  isResultFileDownloadable,
  reviewResumeIdempotencyKey,
  runErrorMessage,
  runResultFiles,
  runResultText,
  upgradeSignedUrlScheme,
} from "./api";
import {
  baseMimetype,
  isMimeAllowed,
  isRuntimeFileInput,
  pickSupportedAudioMimetype,
  pickUploadMimetype,
  resolveRuntimeUploadIdleTimeoutMs,
  resolveRuntimeUploadInitialTimeoutMs,
  selectRuntimeInputStep,
} from "./upload";

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

test("runtime upload initial timeout is derived from policy and file size", () => {
  const timeoutMs = resolveRuntimeUploadInitialTimeoutMs(100 * 1024 * 1024, {
    min_timeout_seconds: 30,
    seconds_per_mebibyte: 3,
    max_timeout_seconds: 900,
    idle_timeout_seconds: 120,
  });

  assert.equal(timeoutMs, 300_000);
});

test("runtime upload initial timeout has a conservative size-based fallback", () => {
  assert.equal(resolveRuntimeUploadInitialTimeoutMs(1 * 1024 * 1024, null), 120_000);
  assert.equal(
    resolveRuntimeUploadInitialTimeoutMs(100 * 1024 * 1024, undefined),
    400_000,
  );
  assert.equal(
    resolveRuntimeUploadInitialTimeoutMs(900 * 1024 * 1024, undefined),
    1_800_000,
  );
});

test("runtime upload idle timeout falls back when policy is missing or invalid", () => {
  assert.equal(resolveRuntimeUploadIdleTimeoutMs(undefined), 120_000);
  assert.equal(
    resolveRuntimeUploadIdleTimeoutMs({
      min_timeout_seconds: 30,
      seconds_per_mebibyte: 3,
      max_timeout_seconds: 900,
      idle_timeout_seconds: 0,
    }),
    120_000,
  );
  assert.equal(
    resolveRuntimeUploadIdleTimeoutMs({
      min_timeout_seconds: 30,
      seconds_per_mebibyte: 3,
      max_timeout_seconds: 900,
      idle_timeout_seconds: 45,
    }),
    45_000,
  );
});

test("MIME helpers accept exact, base, and wildcard matches", () => {
  assert.equal(baseMimetype("audio/webm;codecs=opus"), "audio/webm");
  assert.equal(isMimeAllowed("audio/webm;codecs=opus", ["audio/webm"]), true);
  assert.equal(isMimeAllowed("audio/webm", ["audio/wav"]), false);
  assert.equal(isMimeAllowed("audio/webm", ["audio/*"]), true);
  assert.equal(isMimeAllowed("audio/webm", undefined), true);
  assert.equal(isMimeAllowed("audio/webm", []), true);
});

test("audio MIME picker never falls through to a preferred type that the flow disallows", () => {
  assert.equal(
    pickSupportedAudioMimetype(["audio/wav"], () => true),
    "audio/wav",
  );
  assert.equal(
    pickSupportedAudioMimetype(["audio/wav"], (mime) => mime === "audio/wav"),
    "audio/wav",
  );
  assert.equal(
    pickSupportedAudioMimetype(["audio/wav"], (mime) => mime.startsWith("audio/webm")),
    null,
  );
});

test("runtime input selection uses the first published file input by step order", () => {
  const contract = {
    flow_id: "flow",
    published_flow_version: 1,
    form_fields: [],
    steps_requiring_input: [
      { step_id: "document-step", step_order: 2, input_format: "document" },
      { step_id: "audio-step", step_order: 1, input_format: "audio" },
    ],
  };

  assert.equal(selectRuntimeInputStep(contract)?.step_id, "audio-step");
});

test("runtime input selection falls back to file inputs before arbitrary steps", () => {
  const contract = {
    flow_id: "flow",
    published_flow_version: 1,
    form_fields: [],
    steps_requiring_input: [
      { step_id: "text-step", input_format: "text" },
      { step_id: "file-step", input_format: "file" },
    ],
  };

  assert.equal(selectRuntimeInputStep(contract)?.step_id, "file-step");
});

test("runtime input format classification follows the run-contract upload formats", () => {
  assert.equal(isRuntimeFileInput("audio"), true);
  assert.equal(isRuntimeFileInput("document"), true);
  assert.equal(isRuntimeFileInput("file"), true);
  assert.equal(isRuntimeFileInput("text"), false);
  assert.equal(isRuntimeFileInput(undefined), false);
});

test("run idempotency key is deterministic across object key order", async () => {
  const first = await deriveRunIdempotencyKey({
    flowId: "flow",
    expectedFlowVersion: 1,
    body: {
      expected_flow_version: 1,
      step_inputs: { step: { file_ids: ["file"] } },
      input_payload_json: { b: "2", a: "1" },
    },
  });
  const second = await deriveRunIdempotencyKey({
    flowId: "flow",
    expectedFlowVersion: 1,
    body: {
      input_payload_json: { a: "1", b: "2" },
      step_inputs: { step: { file_ids: ["file"] } },
      expected_flow_version: 1,
    },
  });
  const changed = await deriveRunIdempotencyKey({
    flowId: "flow",
    expectedFlowVersion: 1,
    body: {
      expected_flow_version: 1,
      step_inputs: { step: { file_ids: ["other"] } },
      input_payload_json: { a: "1", b: "2" },
    },
  });

  assert.equal(first, second);
  assert.notEqual(first, changed);
});

test("review checkpoint helpers follow the approve/resume contract", () => {
  assert.equal(isReviewCheckpointApproved(null), false);
  assert.equal(
    isReviewCheckpointApproved({
      id: "checkpoint",
      flow_id: "flow",
      flow_run_id: "run",
      step_id: "step",
      step_order: 1,
      attempt_no: 1,
      state: "awaiting_review",
      revision: 1,
      schema_version: 1,
      created_at: "2026-05-29T10:00:00Z",
      updated_at: "2026-05-29T10:00:00Z",
    }),
    false,
  );
  assert.equal(
    isReviewCheckpointApproved({
      id: "checkpoint",
      flow_id: "flow",
      flow_run_id: "run",
      step_id: "step",
      step_order: 1,
      attempt_no: 1,
      state: "approved",
      revision: 2,
      schema_version: 1,
      created_at: "2026-05-29T10:00:00Z",
      updated_at: "2026-05-29T10:00:00Z",
    }),
    true,
  );
  assert.equal(
    reviewResumeIdempotencyKey("run-id", "checkpoint-id"),
    "review-resume:run-id:checkpoint-id",
  );
});


test("upload mimetype is declared from the step's accepted list", () => {
  // Exakt träff behålls.
  assert.equal(
    pickUploadMimetype("audio/webm", ["audio/webm", "audio/mpeg"]),
    "audio/webm",
  );
  // Filens bastyp matchar en parametriserad post — deklarera listans variant,
  // eftersom Eneo jämför mot den deklarerade strängen.
  assert.equal(
    pickUploadMimetype("audio/webm", ["audio/webm;codecs=opus"]),
    "audio/webm;codecs=opus",
  );
  // Generisk typ + exakt en tillåten typ → deklarera den tillåtna.
  assert.equal(
    pickUploadMimetype("application/octet-stream", ["audio/mpeg"]),
    "audio/mpeg",
  );
  // Generisk typ men flera alternativ → gissa inte.
  assert.equal(
    pickUploadMimetype("application/octet-stream", ["audio/mpeg", "audio/wav"]),
    null,
  );
  // Tydlig men olistad typ → ljug inte om den, låt Eneo avvisa.
  assert.equal(pickUploadMimetype("audio/aac", ["audio/mpeg"]), "audio/aac");
  // Ingen lista → behåll filens typ.
  assert.equal(pickUploadMimetype("audio/webm", undefined), "audio/webm");
  assert.equal(pickUploadMimetype("", undefined), null);
});

test("typed run results replace the removed output_payload_json", () => {
  const base = { id: "run", flow_id: "flow", status: "completed" };

  assert.deepEqual(
    runResultText({ ...base, result: { kind: "inline_text", text: "Hej" } }),
    { text: "Hej", truncated: false },
  );

  const backingFile = { file_id: "f1", name: "transkript.txt" };
  assert.deepEqual(
    runResultText({
      ...base,
      result: { kind: "file_backed_text", preview: "Hej…", file: backingFile },
    }),
    { text: "Hej…", truncated: true },
  );
  assert.deepEqual(
    runResultFiles({
      ...base,
      result: { kind: "file_backed_text", preview: "Hej…", file: backingFile },
    }),
    [backingFile],
  );

  const artifacts = [{ file_id: "f2", name: "rapport.docx" }];
  assert.deepEqual(
    runResultFiles({ ...base, result: { kind: "artifact", files: artifacts } }),
    artifacts,
  );
  assert.equal(
    runResultText({ ...base, result: { kind: "artifact", files: artifacts } }),
    null,
  );

  // Utan typat resultat faller vi tillbaka på alla filer från körningen.
  assert.deepEqual(
    runResultFiles({ ...base, result: null, result_files: artifacts }),
    artifacts,
  );
  assert.equal(runResultText({ ...base, result: null }), null);

  assert.equal(
    runErrorMessage({
      ...base,
      status: "failed",
      error: { code: "step_failed", message: "Steget misslyckades", retryable: false },
    }),
    "Steget misslyckades",
  );
  assert.equal(runErrorMessage({ ...base }), null);
});

test("purged result files are not offered for download", () => {
  assert.equal(isResultFileDownloadable({ file_id: "f" }), true);
  assert.equal(
    isResultFileDownloadable({ file_id: "f", availability: "available" }),
    true,
  );
  assert.equal(
    isResultFileDownloadable({ file_id: "f", availability: "content_purged" }),
    false,
  );
});


test("signed download urls are upgraded to https on an https page", () => {
  const original = (globalThis as { window?: unknown }).window;
  const withProtocol = (protocol: string) => {
    (globalThis as { window?: unknown }).window = {
      location: { protocol },
    };
  };
  try {
    // Eneo mintar http://-URL:er; browsern blockerar dem som mixed content.
    withProtocol("https:");
    assert.equal(
      upgradeSignedUrlScheme("http://flow.example.com/api/v1/files/x/download/"),
      "https://flow.example.com/api/v1/files/x/download/",
    );
    assert.equal(
      upgradeSignedUrlScheme("https://flow.example.com/a"),
      "https://flow.example.com/a",
    );
    // Lokal http-utveckling ska inte röras.
    withProtocol("http:");
    assert.equal(
      upgradeSignedUrlScheme("http://localhost:8000/a"),
      "http://localhost:8000/a",
    );
  } finally {
    if (original === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = original;
  }
});
