"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  Circle,
  Download,
  FileAudio,
  Info,
  Loader2,
  MoreVertical,
  Send,
  Share2,
  Upload,
  XCircle,
} from "lucide-react";
import { use, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Textarea,
} from "@sk-web-gui/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AuthGate } from "@/components/AuthGate";
import { AudioRecorder } from "@/components/AudioRecorder";
import {
  approveReviewCheckpoint,
  deriveRunIdempotencyKey,
  editReviewCheckpoint,
  getActiveReviewCheckpoint,
  getArtifactSignedUrl,
  getFlowGraph,
  getPublishedFlow,
  getRun,
  getRunContract,
  getRunSteps,
  isReviewCheckpointApproved,
  isResultFileDownloadable,
  isTextualOutput,
  resolveFlowOutputType,
  runErrorMessage,
  runResultFiles,
  runResultText,
  rejectReviewCheckpoint,
  resumeReviewCheckpoint,
  reviewResumeIdempotencyKey,
  setSpaceContext,
  startRun,
  uploadStepRuntimeFile,
  type FlowGraph,
  type FlowPublished,
  type FlowRunPublic,
  type FlowRunReviewCheckpointPublic,
  type FlowRunStep,
  type Json,
  type RuntimeUploadTimeoutEvent,
  type RunContract,
  type UploadProgress,
} from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import {
  formatBytes,
  isMimeAllowed,
  isRuntimeFileInput,
  pickUploadMimetype,
  selectRuntimeInputStep,
} from "@/lib/upload";

interface PageProps {
  // Next 15: params levereras som en Promise och packas upp med React.use().
  params: Promise<{ id: string }>;
}

export default function FlowDetailPage({ params }: PageProps) {
  const { id } = use(params);
  return (
    <AuthGate>
      <FlowDetail flowId={id} />
    </AuthGate>
  );
}

type RunState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "running"; run: FlowRunPublic; steps: FlowRunStep[] }
  | {
      kind: "awaiting_review";
      run: FlowRunPublic;
      steps: FlowRunStep[];
      checkpoint: FlowRunReviewCheckpointPublic;
    }
  | { kind: "done"; run: FlowRunPublic; steps: FlowRunStep[] };

type SubmissionState =
  | { kind: "idle" }
  | {
      kind: "uploading";
      filename: string;
      loaded: number;
      total: number | null;
      percent: number | null;
    }
  | { kind: "starting" };

interface ResultFileRef {
  file_id: string;
  name?: string;
  mimetype?: string | null;
  size?: number;
}

function FlowDetail({ flowId }: { flowId: string }) {
  // Läs space-id från ?s= och sätt modul-state SYNKRONT under render-pass
  // så alla efterföljande API-anrop på sidan skickar X-Space-Id-headern.
  const searchParams = useSearchParams();
  const spaceFromQuery = searchParams.get("s");
  setSpaceContext(spaceFromQuery);
  // Rensa contexten när vi lämnar sidan (annars läcker den till /flows-listanrop).
  useEffect(() => {
    return () => setSpaceContext(null);
  }, []);

  const [published, setPublished] = useState<FlowPublished | null>(null);
  const [contract, setContract] = useState<RunContract | null>(null);
  const [graph, setGraph] = useState<FlowGraph | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [file, setFile] = useState<{ blob: Blob; filename: string } | null>(
    null,
  );
  const [run, setRun] = useState<RunState>({ kind: "idle" });
  const [submission, setSubmission] = useState<SubmissionState>({
    kind: "idle",
  });
  const [recordingActive, setRecordingActive] = useState(false);
  const [signedUrls, setSignedUrls] = useState<
    Record<string, { url: string }>
  >({});

  const pollAbortRef = useRef<{ aborted: boolean }>({ aborted: false });
  const submitAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getPublishedFlow(flowId),
      getRunContract(flowId),
      getFlowGraph(flowId).catch(() => null),
    ])
      .then(([p, c, g]) => {
        if (cancelled) return;
        setPublished(p);
        setContract(c);
        setGraph(g);
        const defaults: Record<string, string> = {};
        for (const f of c.form_fields ?? []) {
          if (f.default != null) defaults[f.name] = String(f.default);
        }
        setFormValues(defaults);
      })
      .catch((err) => !cancelled && setLoadError(friendlyError(err)));
    return () => {
      cancelled = true;
    };
  }, [flowId]);

  useEffect(() => {
    return () => {
      pollAbortRef.current.aborted = true;
      submitAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const shouldWarn = recordingActive || submission.kind !== "idle";
    if (!shouldWarn) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [recordingActive, submission.kind]);

  const runtimeInput = useMemo(
    () => selectRuntimeInputStep(contract),
    [contract],
  );
  const inputType = runtimeInput?.input_format;
  const acceptsUpload = !!runtimeInput && isRuntimeFileInput(inputType);
  const acceptedMimetypes = runtimeInput?.accepted_mimetypes ?? [];
  const maxFileSizeBytes = runtimeInput?.max_file_size_bytes;

  // Etiketter per step_id hämtas från grafen — nya specen tappar step_label på FlowRunStep.
  const stepLabels = useMemo<Record<string, string>>(() => {
    if (!graph) return {};
    const m: Record<string, string> = {};
    for (const n of graph.nodes) {
      if (n.label) m[n.id] = n.label;
    }
    return m;
  }, [graph]);
  const requiresFile = acceptsUpload && runtimeInput?.required !== false;

  const formFields = contract?.form_fields ?? [];

  const canSubmit = useMemo(() => {
    if (run.kind !== "idle") return false;
    if (!contract) return false;
    if (requiresFile && !file) return false;
    for (const f of formFields) {
      if (f.required) {
        const v = formValues[f.name];
        if (!v || v.trim().length === 0) return false;
      }
    }
    return true;
  }, [run.kind, contract, requiresFile, file, formFields, formValues]);

  function setField(key: string, value: string) {
    setFormValues((prev) => ({ ...prev, [key]: value }));
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) {
      setFile(null);
      return;
    }
    if (maxFileSizeBytes && f.size > maxFileSizeBytes) {
      setRunError(
        `Filen är för stor (${formatBytes(f.size)}). Max: ${formatBytes(maxFileSizeBytes)}.`,
      );
      e.target.value = "";
      return;
    }
    if (f.type && !isMimeAllowed(f.type, acceptedMimetypes)) {
      setRunError(
        `Filtypen "${f.type}" stöds inte. Tillåtna: ${acceptedMimetypes.join(", ")}.`,
      );
      e.target.value = "";
      return;
    }
    setRunError(null);
    setFile({ blob: f, filename: f.name });
  }

  async function onRecorded(blob: Blob | null, fname: string | null) {
    if (blob && fname) setFile({ blob, filename: fname });
    else setFile(null);
  }

  async function onRun() {
    if (!contract) return;
    setRunError(null);
    setSignedUrls({});
    setRun({ kind: "submitting" });
    setSubmission({ kind: "idle" });

    try {
      let fileId: string | null = null;
      if (file) {
        if (!runtimeInput) {
          throw new Error("Flödet saknar ett runtime-input-steg för filen.");
        }
        if (maxFileSizeBytes && file.blob.size > maxFileSizeBytes) {
          throw new Error(
            `Filen är för stor (${formatBytes(file.blob.size)}). Max: ${formatBytes(maxFileSizeBytes)}.`,
          );
        }

        const abortController = new AbortController();
        submitAbortRef.current = abortController;
        setSubmission({
          kind: "uploading",
          filename: file.filename,
          loaded: 0,
          total: file.blob.size,
          percent: 0,
        });

        const uploaded = await uploadStepRuntimeFile(
          flowId,
          runtimeInput.step_id,
          file.blob,
          file.filename,
          {
            signal: abortController.signal,
            runtimeUploadPolicy: contract.runtime_upload_policy,
            // Eneo avvisar numera generiska/olistade deklarerade MIME-typer.
            contentType: pickUploadMimetype(
              file.blob.type,
              runtimeInput.accepted_mimetypes,
            ),
            onProgress: (progress: UploadProgress) => {
              setSubmission({
                kind: "uploading",
                filename: file.filename,
                loaded: progress.loaded,
                total: progress.total ?? file.blob.size,
                percent:
                  progress.percent ??
                  Math.round((progress.loaded / file.blob.size) * 100),
              });
            },
            onTimeout: (event: RuntimeUploadTimeoutEvent) => {
              setRunError(labelForUploadTimeout(event.reason));
            },
          },
        );
        fileId = uploaded.id;
      }

      setSubmission({ kind: "starting" });
      const stepInputId = runtimeInput?.step_id ?? null;

      // FlowRunCreateRequest avvisar okända fält (additionalProperties: false).
      // Skicka bara expected_flow_version, step_inputs och input_payload_json.
      const body: Json = {
        expected_flow_version: contract.published_flow_version,
      };

      if (fileId && stepInputId) {
        body.step_inputs = { [stepInputId]: { file_ids: [fileId] } };
      }

      const inputPayload: Record<string, unknown> = {};
      for (const f of formFields) {
        const v = formValues[f.name];
        if (v == null || v === "") continue;
        inputPayload[f.name] = v;
      }
      if (Object.keys(inputPayload).length > 0) {
        body.input_payload_json = inputPayload;
      }

      const idempotencyKey = await deriveRunIdempotencyKey({
        flowId,
        expectedFlowVersion: contract.published_flow_version,
        body,
      });
      const initialRun = await startRun(flowId, body, idempotencyKey);
      submitAbortRef.current = null;
      setSubmission({ kind: "idle" });

      pollAbortRef.current = { aborted: false };
      setRun({ kind: "running", run: initialRun, steps: [] });
      pollUntilDone(initialRun.id, pollAbortRef.current);
    } catch (err) {
      setRunError(friendlyError(err));
      setRun({ kind: "idle" });
      setSubmission({ kind: "idle" });
      submitAbortRef.current = null;
    }
  }

  async function pollUntilDone(
    runId: string,
    abort: { aborted: boolean },
  ) {
    const intervalMs = 1500;
    while (!abort.aborted) {
      try {
        const [r, steps] = await Promise.all([
          getRun(flowId, runId),
          getRunSteps(flowId, runId).catch(() => [] as FlowRunStep[]),
        ]);
        if (abort.aborted) return;
        if (isTerminal(r.status)) {
          setRun({ kind: "done", run: r, steps });
          if (isSuccess(r.status)) {
            await fetchSignedUrls(runId, runResultFiles(r));
          }
          return;
        }
        if (r.status === "awaiting_review") {
          // Hämta active checkpoint; om vi inte hittar någon (race) fortsätter vi polla.
          const cp = await getActiveReviewCheckpoint(flowId, runId).catch(
            () => null,
          );
          if (abort.aborted) return;
          if (cp) {
            setRun({ kind: "awaiting_review", run: r, steps, checkpoint: cp });
            // Vänta tills användaren agerat — review-UI:t avbryter pollingen
            // via pollAbortRef när knapp trycks. Här stannar vi helt.
            return;
          }
        }
        setRun({ kind: "running", run: r, steps });
      } catch (err) {
        if (abort.aborted) return;
        setRunError(friendlyError(err));
        setRun({ kind: "idle" });
        return;
      }
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  }

  async function onApproveAndResume(
    checkpoint: FlowRunReviewCheckpointPublic,
    runState: { run: FlowRunPublic; steps: FlowRunStep[] },
  ) {
    setRunError(null);
    try {
      const approved = await approveCheckpointWithRecovery(
        checkpoint,
        runState.run.id,
      );
      const resumedRun = await resumeCheckpointWithRecovery(
        approved,
        runState.run,
      );
      // Återstarta polling — runen är nu i "running" igen.
      pollAbortRef.current = { aborted: false };
      setRun({ kind: "running", run: resumedRun, steps: runState.steps });
      pollUntilDone(resumedRun.id, pollAbortRef.current);
    } catch (err) {
      setRunError(friendlyError(err));
    }
  }

  async function approveCheckpointWithRecovery(
    checkpoint: FlowRunReviewCheckpointPublic,
    runId: string,
  ): Promise<FlowRunReviewCheckpointPublic> {
    try {
      return await approveReviewCheckpoint(flowId, runId, checkpoint.id, {
        expected_checkpoint_revision: checkpoint.revision,
      });
    } catch (err) {
      const latest = await getActiveReviewCheckpoint(flowId, runId).catch(
        () => null,
      );
      if (latest?.id === checkpoint.id && isReviewCheckpointApproved(latest)) {
        return latest;
      }
      throw err;
    }
  }

  async function resumeCheckpointWithRecovery(
    checkpoint: FlowRunReviewCheckpointPublic,
    run: FlowRunPublic,
  ): Promise<FlowRunPublic> {
    const idempotencyKey = reviewResumeIdempotencyKey(run.id, checkpoint.id);
    try {
      const resumed = await resumeReviewCheckpoint(
        flowId,
        run.id,
        checkpoint.id,
        { expected_checkpoint_revision: checkpoint.revision },
        idempotencyKey,
      );
      return resumed.run;
    } catch (err) {
      const [latestRun, latestCheckpoint] = await Promise.all([
        getRun(flowId, run.id).catch(() => null),
        getActiveReviewCheckpoint(flowId, run.id).catch(() => null),
      ]);
      const checkpointMovedPastActiveReview =
        !latestCheckpoint ||
        (latestCheckpoint.id === checkpoint.id &&
          latestCheckpoint.state === "resumed");
      if (
        latestRun &&
        latestRun.status !== "awaiting_review" &&
        checkpointMovedPastActiveReview
      ) {
        return latestRun;
      }
      throw err;
    }
  }

  async function onSaveEdit(
    checkpoint: FlowRunReviewCheckpointPublic,
    editedValue: string | Json | unknown[],
  ): Promise<FlowRunReviewCheckpointPublic | null> {
    setRunError(null);
    try {
      const updated = await editReviewCheckpoint(
        flowId,
        checkpoint.flow_run_id,
        checkpoint.id,
        {
          expected_checkpoint_revision: checkpoint.revision,
          edited_value: editedValue,
        },
      );
      setRun((prev) =>
        prev.kind === "awaiting_review"
          ? { ...prev, checkpoint: updated }
          : prev,
      );
      return updated;
    } catch (err) {
      setRunError(friendlyError(err));
      return null;
    }
  }

  async function onReject(
    checkpoint: FlowRunReviewCheckpointPublic,
    runState: { run: FlowRunPublic; steps: FlowRunStep[] },
    reason: string,
  ) {
    setRunError(null);
    try {
      await rejectReviewCheckpoint(flowId, runState.run.id, checkpoint.id, {
        expected_checkpoint_revision: checkpoint.revision,
        reason,
      });
      // Run blir cancelled — hämta uppdaterat tillstånd och gå till "done".
      const r = await getRun(flowId, runState.run.id);
      setRun({ kind: "done", run: r, steps: runState.steps });
    } catch (err) {
      setRunError(friendlyError(err));
    }
  }

  async function fetchSignedUrls(runId: string, files: ResultFileRef[]) {
    const entries = await Promise.all(
      files.map(async (a) => {
        // `content_purged` ger 410 vid nedladdning — begär ingen URL alls.
        if (!isResultFileDownloadable(a)) return null;
        try {
          const r = await getArtifactSignedUrl(flowId, runId, a.file_id);
          return [a.file_id, { url: r.url }] as const;
        } catch {
          return null;
        }
      }),
    );
    const map: Record<string, { url: string }> = {};
    for (const e of entries) {
      if (e) map[e[0]] = e[1];
    }
    setSignedUrls(map);
  }

  function onRunAgain() {
    pollAbortRef.current.aborted = true;
    pollAbortRef.current = { aborted: false };
    setSignedUrls({});
    setRunError(null);
    setRun({ kind: "idle" });
  }

  function onCancelSubmission() {
    submitAbortRef.current?.abort();
    submitAbortRef.current = null;
    setSubmission({ kind: "idle" });
    setRun({ kind: "idle" });
  }

  if (loadError) {
    return (
      <>
        <NavBar title="Fel" />
        <main className="px-6 py-4">
          <p className="text-accent">{loadError}</p>
          <Link
            href="/flows"
            className="text-sm text-ink-soft underline mt-3 inline-block"
          >
            Tillbaka
          </Link>
        </main>
      </>
    );
  }

  if (!published || !contract) {
    return (
      <>
        <NavBar title="Laddar" />
        <main className="grid place-items-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-ink-mute" />
        </main>
      </>
    );
  }

  const outputType = resolveFlowOutputType(contract, graph);
  const isTextual = isTextualOutput(outputType);

  const phase: "setup" | "recording" | "review" | "notes" =
    run.kind === "done"
      ? "notes"
      : run.kind === "awaiting_review"
        ? "review"
        : run.kind === "running" || run.kind === "submitting"
          ? "recording"
          : "setup";

  if (phase === "setup") {
    return (
      <SetupView
        published={published}
        contract={contract}
        outputType={outputType}
        formValues={formValues}
        setField={setField}
        inputType={inputType}
        acceptsUpload={acceptsUpload}
        acceptedMimetypes={acceptedMimetypes}
        maxFileSizeBytes={maxFileSizeBytes}
        file={file}
        onFilePicked={onFilePicked}
        onRecorded={onRecorded}
        onRecordingChange={setRecordingActive}
        canSubmit={canSubmit}
        submitting={run.kind === "submitting"}
        onRun={onRun}
        runError={runError}
      />
    );
  }

  if (phase === "recording" && run.kind !== "idle" && run.kind !== "done") {
    return (
      <RecordingView
        published={published}
        run={run.kind === "running" ? run.run : undefined}
        steps={run.kind === "running" ? run.steps : []}
        stepLabels={stepLabels}
        submission={submission}
        onCancelSubmission={onCancelSubmission}
      />
    );
  }

  if (phase === "review" && run.kind === "awaiting_review") {
    return (
      <ReviewView
        published={published}
        checkpoint={run.checkpoint}
        runState={{ run: run.run, steps: run.steps }}
        runError={runError}
        onApprove={(cp) =>
          onApproveAndResume(cp, { run: run.run, steps: run.steps })
        }
        onSaveEdit={onSaveEdit}
        onReject={(cp, reason) =>
          onReject(cp, { run: run.run, steps: run.steps }, reason)
        }
      />
    );
  }

  if (phase === "notes" && run.kind === "done") {
    return (
      <NotesView
        published={published}
        runState={run}
        signedUrls={signedUrls}
        outputType={outputType}
        isTextual={isTextual}
        onRunAgain={onRunAgain}
        stepLabels={stepLabels}
      />
    );
  }

  return null;
}

// ---------- NavBar ----------

function NavBar({
  title,
  back = "/flows",
}: {
  title: string;
  back?: string;
}) {
  return (
    <nav className="flex items-center justify-between px-5 md:px-8 pt-4 md:pt-6 pb-2">
      <Link
        href={back}
        aria-label="Tillbaka"
        className="grid h-[42px] w-[42px] place-items-center rounded-full bg-paper border border-rule-soft text-ink transition-transform active:scale-95 shrink-0"
      >
        <ChevronLeft
          strokeWidth={2}
          style={{ width: 20, height: 20 }}
        />
      </Link>
      <div className="truncate px-3 text-[15px] md:text-[16px] font-semibold text-ink">
        {title}
      </div>
      <button
        type="button"
        aria-label="Mer"
        disabled
        className="grid h-[42px] w-[42px] place-items-center rounded-full text-ink-soft opacity-40 shrink-0"
      >
        <MoreVertical strokeWidth={1.5} style={{ width: 20, height: 20 }} />
      </button>
    </nav>
  );
}

// ---------- Setup ----------

function SetupView({
  published,
  contract,
  outputType,
  formValues,
  setField,
  inputType,
  acceptsUpload,
  acceptedMimetypes,
  maxFileSizeBytes,
  file,
  onFilePicked,
  onRecorded,
  onRecordingChange,
  canSubmit,
  submitting,
  onRun,
  runError,
}: {
  published: FlowPublished;
  contract: RunContract;
  outputType: string | null;
  formValues: Record<string, string>;
  setField: (k: string, v: string) => void;
  inputType?: string;
  acceptsUpload: boolean;
  acceptedMimetypes: string[];
  maxFileSizeBytes?: number;
  file: { blob: Blob; filename: string } | null;
  onFilePicked: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRecorded: (blob: Blob | null, fname: string | null) => void;
  onRecordingChange: (recording: boolean) => void;
  canSubmit: boolean;
  submitting: boolean;
  onRun: () => void;
  runError: string | null;
}) {
  const formFields = contract.form_fields ?? [];
  const [localFileUrl, setLocalFileUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setLocalFileUrl(null);
      return;
    }
    const url = URL.createObjectURL(file.blob);
    setLocalFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <>
      <NavBar title={published.name} />

      <div className="px-6 md:px-8 pt-2 md:pt-4 pb-6 flex-1 flex flex-col w-full mx-auto max-w-2xl">
        <h1 className="text-[28px] md:text-[34px] font-semibold tracking-[-0.025em] leading-[1.1] mb-1.5">
          Förbered <span className="accent-em">ditt möte</span>
        </h1>
        <p className="text-[14px] text-ink-soft leading-relaxed mb-3">
          {published.description ||
            "Lite info hjälper Flöden att skräddarsy transkriptet."}
        </p>
        <div className="mb-6" />

        <div className="flex items-center gap-4 rounded-2xl border border-ochre/40 bg-ochre/10 pl-5 pr-5 py-3.5 mb-6">
          <Info
            size={24}
            strokeWidth={2}
            aria-hidden
            style={{ width: 24, height: 24, flexShrink: 0 }}
            className="text-ochre"
          />
          <p className="text-[12.5px] text-ink-soft leading-relaxed">
            Använd bara{" "}
            <span className="text-ink font-medium">
              öppen och publik information
            </span>{" "}
            i det här flödet. Ladda inte upp personuppgifter, sekretessbelagda
            eller på annat sätt känsliga uppgifter.
          </p>
        </div>

        {formFields.length > 0 && (
          <div className="flex flex-col gap-5 mb-6">
            {formFields.map((f) => {
              const k = f.name;
              const value = formValues[k] ?? "";
              const inputTypeAttr =
                f.type === "date"
                  ? "date"
                  : f.type === "number"
                    ? "number"
                    : "text";
              const isLong =
                f.type === "textarea" ||
                f.type === "long_text" ||
                (inputTypeAttr === "text" && value.length > 80);
              return (
                <FormControl
                  key={k}
                  id={k}
                  required={f.required}
                  className="w-full"
                >
                  <FormLabel className="eyebrow-sm">
                    {f.label || f.name}
                  </FormLabel>
                  {f.description && (
                    <FormHelperText className="text-xs text-ink-mute">
                      {f.description}
                    </FormHelperText>
                  )}
                  {isLong ? (
                    <Textarea
                      value={value}
                      onChange={(e) => setField(k, e.target.value)}
                      rows={4}
                      className="w-full"
                    />
                  ) : (
                    <Input
                      type={inputTypeAttr}
                      value={value}
                      onChange={(e) => setField(k, e.target.value)}
                      className="w-full"
                    />
                  )}
                </FormControl>
              );
            })}
          </div>
        )}

        {inputType === "audio" && (
          <>
            <section className="mt-4 mb-8 md:mt-6 md:mb-12">
              <AudioRecorder
                acceptedMimetypes={acceptedMimetypes}
                maxBytes={maxFileSizeBytes}
                onChange={onRecorded}
                onRecordingChange={onRecordingChange}
                title={published.name}
                subtitle={inputType.toUpperCase()}
              />
            </section>

            <div
              className="flex items-center gap-3 my-4 md:my-5"
              aria-hidden
            >
              <div className="flex-1 h-px bg-rule-soft" />
              <span className="eyebrow-sm">eller</span>
              <div className="flex-1 h-px bg-rule-soft" />
            </div>

            <label className="paper-card flex items-center gap-3 md:gap-4 px-4 py-3.5 md:px-5 md:py-4 cursor-pointer transition-colors hover:border-ink/40 mb-2">
              <div className="grid place-items-center h-10 w-10 md:h-12 md:w-12 rounded-xl bg-bg-2 text-ink-soft shrink-0">
                <FileAudio className="h-4 w-4 md:h-5 md:w-5" strokeWidth={1.8} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] md:text-[15px] font-medium text-ink leading-tight">
                  Ladda upp ljudfil
                </div>
                <div className="text-[12px] md:text-[13px] text-ink-mute mt-0.5 truncate">
                  {file
                    ? `${file.filename} · ${formatBytes(file.blob.size)}`
                    : (acceptedMimetypes.length
                        ? acceptedMimetypes
                            .map((m) =>
                              m
                                .replace(/^audio\//, "")
                                .replace(/^video\//, "")
                                .replace(/^x-/, "")
                                .toUpperCase(),
                            )
                            .filter((v, i, a) => a.indexOf(v) === i)
                            .slice(0, 6)
                            .join(" · ")
                        : "MP3 · WAV · M4A · OGG")}
                </div>
              </div>
              <Upload
                className="h-4 w-4 md:h-5 md:w-5 text-ink-mute shrink-0"
                strokeWidth={1.8}
              />
              <input
                type="file"
                accept={acceptedMimetypes.join(",") || "audio/*"}
                onChange={onFilePicked}
                className="sr-only"
              />
            </label>
            {file && localFileUrl && (
              <div className="flex items-center justify-between gap-3 mb-2 px-1">
                <p className="text-[12px] text-ink-mute">
                  Spara gärna en kopia innan du startar. Om sidan stängs innan
                  uppladdningen är klar kan inspelningen gå förlorad.
                </p>
                <a
                  href={localFileUrl}
                  download={file.filename}
                  className="shrink-0 text-[12px] font-medium text-ink underline underline-offset-4"
                >
                  Spara kopia
                </a>
              </div>
            )}
          </>
        )}

        {inputType !== "audio" && acceptsUpload && (
          <section className="paper-card p-5 md:p-6 mb-3 space-y-3">
            <div className="eyebrow-sm">Fil</div>
            <input
              type="file"
              accept={acceptedMimetypes.join(",") || undefined}
              onChange={onFilePicked}
              className="text-sm text-ink-soft"
            />
            {file && (
              <p className="text-[13px] text-ink-soft">
                Vald: <span className="text-ink">{file.filename}</span> (
                {formatBytes(file.blob.size)})
              </p>
            )}
            {maxFileSizeBytes && (
              <p className="text-xs text-ink-mute">
                Max storlek: {formatBytes(maxFileSizeBytes)}
              </p>
            )}
          </section>
        )}

        {runError && (
          <div
            className="bg-accent text-paper rounded-2xl px-4 py-3.5 md:px-5 md:py-4 mt-4 flex items-start gap-3"
            role="alert"
          >
            <AlertCircle
              className="h-5 w-5 md:h-6 md:w-6 shrink-0 mt-0.5"
              strokeWidth={2}
            />
            <div className="flex-1 min-w-0">
              <div className="font-mono text-[9px] md:text-[10px] tracking-[0.16em] uppercase text-paper/80 mb-1">
                Fel
              </div>
              <p className="text-[14px] md:text-[15px] font-medium leading-snug break-words">
                {runError}
              </p>
            </div>
          </div>
        )}

        <div className="pt-5 md:pt-6 flex justify-center">
          <Button
            type="button"
            color="vattjom"
            variant="primary"
            size="md"
            onClick={onRun}
            loading={submitting}
            loadingText="Startar…"
            disabled={!canSubmit || submitting}
            className="text-[14px]"
          >
            Kör flöde
          </Button>
        </div>
      </div>
    </>
  );
}

// ---------- Recording (post-submit, pre-result) ----------

function RecordingView({
  published,
  run,
  steps,
  stepLabels,
  submission,
  onCancelSubmission,
}: {
  published: FlowPublished;
  run?: FlowRunPublic;
  steps: FlowRunStep[];
  stepLabels: Record<string, string>;
  submission: SubmissionState;
  onCancelSubmission: () => void;
}) {
  const isUploading = submission.kind === "uploading";
  return (
    <>
      <header className="flex items-center justify-between px-5 md:px-8 pt-4 md:pt-6 pb-2">
        <div className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.18em] uppercase text-accent">
          <span
            aria-hidden
            className="lyssna-live-pulse h-1.5 w-1.5 rounded-full bg-accent"
          />
          Bearbetar
        </div>
        <div className="font-mono text-[10px] tracking-wider text-ink-mute">
          v{published.published_version}
        </div>
      </header>

      <div className="flex-1 flex flex-col items-center justify-center px-6 md:px-8 py-8 rec-bg">
        <div className="text-center mb-8 md:mb-10 w-full max-w-2xl">
          <div className="text-[19px] md:text-[28px] font-semibold tracking-[-0.015em] leading-tight">
            {published.name}
          </div>
          <div className="font-mono text-[10px] md:text-[11px] tracking-[0.14em] uppercase text-ink-mute mt-1.5 md:mt-2">
            {isUploading
              ? "Laddar upp ljudfil…"
              : submission.kind === "starting"
                ? "Startar flöde…"
                : run
                  ? labelForRunStatus(run.status)
                  : "Skickar…"}
          </div>
        </div>

        {isUploading ? (
          <UploadProgressCard
            submission={submission}
            onCancel={onCancelSubmission}
          />
        ) : (
          <div className="grid place-items-center mb-7 md:mb-10">
            <Loader2 className="h-9 w-9 md:h-12 md:w-12 animate-spin text-accent" />
          </div>
        )}

        <div className="w-full max-w-[300px] md:max-w-lg lg:max-w-xl paper-card p-4 md:p-6 lg:p-7">
          <div className="font-mono text-[9px] md:text-[10px] tracking-[0.16em] uppercase text-accent mb-2 md:mb-3 inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="lyssna-live-pulse h-1 w-1 rounded-full bg-accent"
            />
            Pågår
          </div>
          <StepProgress steps={steps} stepLabels={stepLabels} />
        </div>
      </div>
    </>
  );
}

function UploadProgressCard({
  submission,
  onCancel,
}: {
  submission: Extract<SubmissionState, { kind: "uploading" }>;
  onCancel: () => void;
}) {
  const percent = Math.max(0, Math.min(100, submission.percent ?? 0));
  return (
    <div className="w-full max-w-[340px] md:max-w-lg paper-card p-4 md:p-5 mb-7 md:mb-10">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0">
          <div className="eyebrow-sm text-accent">Uppladdning</div>
          <div className="text-[14px] md:text-[15px] font-medium text-ink truncate mt-1">
            {submission.filename}
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded-full border border-rule-soft px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-ink/40 hover:text-ink"
        >
          Avbryt
        </button>
      </div>
      <div className="h-2 rounded-full bg-bg-2 overflow-hidden mb-2">
        <div
          className="h-full rounded-full bg-accent transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[12px] text-ink-mute">
        <span>
          {formatBytes(submission.loaded)}
          {submission.total ? ` av ${formatBytes(submission.total)}` : ""}
        </span>
        <span>{submission.percent != null ? `${percent}%` : "Pågår"}</span>
      </div>
    </div>
  );
}

function StepProgress({
  steps,
  stepLabels,
}: {
  steps: FlowRunStep[];
  stepLabels: Record<string, string>;
}) {
  if (steps.length === 0) {
    return (
      <p className="text-[14px] md:text-[16px] text-ink-soft leading-relaxed">
        Väntar på första steget…
        <span className="lyssna-blink text-accent ml-0.5">|</span>
      </p>
    );
  }
  return (
    <ol className="space-y-1.5 md:space-y-2.5">
      {steps.map((s, i) => {
        const status = s.status.toLowerCase();
        const success = SUCCESS_STATUSES.has(status);
        const failed = FAILURE_STATUSES.has(status);
        const running = status === "running" || status === "in_progress";
        const Icon = success
          ? CheckCircle2
          : failed
            ? XCircle
            : running
              ? Loader2
              : Circle;
        const iconClass = success
          ? "text-ink"
          : failed
            ? "text-accent"
            : running
              ? "text-accent animate-spin"
              : "text-ink-mute";
        return (
          <li
            key={s.id}
            className="flex items-start gap-2.5 md:gap-3.5 py-1 md:py-1.5"
          >
            <Icon
              className={`h-3.5 w-3.5 md:h-5 md:w-5 mt-0.5 md:mt-1 shrink-0 ${iconClass}`}
              strokeWidth={1.6}
            />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] md:text-[16px] font-medium leading-snug md:leading-relaxed truncate md:whitespace-normal md:overflow-visible">
                <span className="text-ink-mute font-mono text-[10px] md:text-[12px] mr-1.5 md:mr-2">
                  {(i + 1).toString().padStart(2, "0")}
                </span>
                {(s.step_id && stepLabels[s.step_id]) ||
                  s.step_label ||
                  s.step_name ||
                  s.step_id}
              </div>
              <div className="text-[10px] md:text-[11px] font-mono uppercase tracking-wider text-ink-mute mt-0.5 md:mt-1">
                {labelForStepStatus(s.status)}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------- Review (human-in-the-loop pause) ----------

function ReviewView({
  published,
  checkpoint,
  runState,
  runError,
  onApprove,
  onSaveEdit,
  onReject,
}: {
  published: FlowPublished;
  checkpoint: FlowRunReviewCheckpointPublic;
  runState: { run: FlowRunPublic; steps: FlowRunStep[] };
  runError: string | null;
  onApprove: (cp: FlowRunReviewCheckpointPublic) => Promise<void>;
  onSaveEdit: (
    cp: FlowRunReviewCheckpointPublic,
    editedValue: string | Json | unknown[],
  ) => Promise<FlowRunReviewCheckpointPublic | null>;
  onReject: (cp: FlowRunReviewCheckpointPublic, reason: string) => Promise<void>;
}) {
  const initialText = extractCheckpointText(checkpoint.current_payload_json);
  const [text, setText] = useState<string>(initialText);
  const [editing, setEditing] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [working, setWorking] = useState<"approve" | "reject" | null>(null);
  const [showReject, setShowReject] = useState<boolean>(false);
  const [rejectReason, setRejectReason] = useState<string>("");

  // Synka när checkpoint uppdateras (t.ex. efter PATCH).
  useEffect(() => {
    setText(extractCheckpointText(checkpoint.current_payload_json));
  }, [checkpoint.revision, checkpoint.current_payload_json]);

  const editable = checkpoint.review_mode === "edit";
  const dirty = editing && text !== initialText;

  async function saveAndApprove() {
    setWorking("approve");
    let cp = checkpoint;
    if (dirty) {
      setSaving(true);
      const updated = await onSaveEdit(checkpoint, buildEditedValue(checkpoint, text));
      setSaving(false);
      if (!updated) {
        setWorking(null);
        return;
      }
      cp = updated;
    }
    try {
      await onApprove(cp);
    } finally {
      setWorking(null);
    }
  }

  async function saveOnly() {
    if (!dirty) return;
    setSaving(true);
    await onSaveEdit(checkpoint, buildEditedValue(checkpoint, text));
    setSaving(false);
    setEditing(false);
  }

  async function submitReject() {
    if (!rejectReason.trim()) return;
    setWorking("reject");
    try {
      await onReject(checkpoint, rejectReason.trim());
    } finally {
      setWorking(null);
    }
  }

  return (
    <>
      <header className="flex items-center justify-between px-5 pt-4 pb-2">
        <Link
          href="/flows"
          aria-label="Tillbaka"
          className="grid h-9 w-9 place-items-center rounded-full bg-paper border border-rule-soft text-ink transition-transform active:scale-95"
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
        </Link>
        <div className="eyebrow inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="lyssna-live-pulse h-1.5 w-1.5 rounded-full bg-accent"
          />
          Granskning
        </div>
        <div className="font-mono text-[10px] tracking-wider text-ink-mute">
          v{published.published_version}
        </div>
      </header>

      <main className="px-6 md:px-8 pt-2 md:pt-4 pb-6 flex-1 flex flex-col w-full mx-auto max-w-3xl">
        <h1 className="text-[24px] md:text-[30px] font-semibold tracking-[-0.025em] leading-[1.15] mb-1">
          {checkpoint.step_label ?? "Granska resultatet"}
        </h1>
        <p className="text-[13px] text-ink-soft leading-relaxed mb-5">
          Flödet är pausat i steg {checkpoint.step_order}.{" "}
          {editable
            ? "Du kan ändra texten innan du godkänner och fortsätter."
            : "Granska innehållet och välj om flödet ska fortsätta."}
        </p>

        <section className="paper-card p-4 mb-5">
          <div className="flex items-center justify-between mb-3">
            <div className="eyebrow-sm">Innehåll för granskning</div>
            <div className="font-mono text-[9px] tracking-wider text-ink-mute uppercase">
              rev {checkpoint.revision} ·{" "}
              {editable ? "redigerbart" : "skrivskyddat"}
            </div>
          </div>

          {editable && editing ? (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={Math.min(24, Math.max(8, text.split("\n").length + 1))}
              className="w-full text-[14px] md:text-[15px] leading-relaxed p-3 md:p-4 rounded-lg border border-rule-soft bg-bg-2/40 focus:outline-none focus:border-ink/30 font-sans"
            />
          ) : (
            <article className="prose prose-sm md:prose-base max-w-none text-[14px] md:text-[15px] leading-relaxed">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            </article>
          )}

          {editable && (
            <div className="flex items-center justify-end gap-2 mt-3">
              {editing ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setText(initialText);
                      setEditing(false);
                    }}
                    disabled={saving}
                    className="text-[12px] text-ink-soft hover:text-ink px-3 py-1.5 transition-colors disabled:opacity-50"
                  >
                    Avbryt
                  </button>
                  <button
                    type="button"
                    onClick={saveOnly}
                    disabled={!dirty || saving}
                    className="inline-flex items-center gap-1.5 rounded-full bg-paper border border-rule-soft text-ink px-3.5 py-1.5 text-[12px] font-medium disabled:opacity-50"
                  >
                    {saving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : null}
                    Spara ändring
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="text-[12px] text-ink-soft hover:text-ink px-3 py-1.5 transition-colors"
                >
                  Redigera
                </button>
              )}
            </div>
          )}
        </section>

        {runError && (
          <p className="text-[13px] text-accent mb-3" role="alert">
            {runError}
          </p>
        )}

        {showReject ? (
          <section className="paper-card p-4 mb-5">
            <div className="eyebrow-sm mb-2">Avvisa körningen</div>
            <p className="text-[12px] text-ink-soft mb-3">
              Ange en kort motivering. Körningen kommer att avbrytas.
            </p>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              placeholder="Skäl …"
              className="w-full text-[13px] p-3 rounded-lg border border-rule-soft bg-bg-2/40 focus:outline-none focus:border-ink/30 mb-3"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowReject(false);
                  setRejectReason("");
                }}
                disabled={working === "reject"}
                className="text-[12px] text-ink-soft hover:text-ink px-3 py-1.5 transition-colors disabled:opacity-50"
              >
                Avbryt
              </button>
              <button
                type="button"
                onClick={submitReject}
                disabled={!rejectReason.trim() || working === "reject"}
                className="inline-flex items-center gap-1.5 rounded-full bg-accent text-paper px-4 py-2 text-[13px] font-medium disabled:opacity-50"
              >
                {working === "reject" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                Bekräfta avvisning
              </button>
            </div>
          </section>
        ) : null}

        <div className="mt-auto flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setShowReject(true)}
            disabled={working !== null || showReject}
            className="text-[13px] text-ink-soft hover:text-accent transition-colors disabled:opacity-50"
          >
            Avvisa
          </button>
          <Button
            type="button"
            color="vattjom"
            variant="primary"
            onClick={saveAndApprove}
            loading={working === "approve"}
            disabled={working !== null || saving}
            leftIcon={<CheckCircle2 className="h-4 w-4" strokeWidth={2} />}
          >
            {dirty ? "Spara och fortsätt" : "Godkänn och fortsätt"}
          </Button>
        </div>
      </main>
    </>
  );
}

/**
 * `edited_value` är det korrigerade stegresultatet självt — inte en envelope.
 * Text-steg tar en sträng; json-steg tar objektet/arrayen.
 */
function buildEditedValue(
  checkpoint: FlowRunReviewCheckpointPublic,
  text: string,
): string | Json | unknown[] {
  if (checkpoint.output_type !== "json") return text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && (typeof parsed === "object" || Array.isArray(parsed))) {
      return parsed as Json | unknown[];
    }
  } catch {
    // Inte giltig JSON — låt Eneo validera mot output_contract och svara.
  }
  return { text };
}

function extractCheckpointText(payload: Json | null | undefined): string {
  if (!payload) return "";
  const text = (payload as { text?: unknown }).text;
  if (typeof text === "string") return text;
  // Fallback: visa payloaden som JSON så användaren ändå kan granska.
  try {
    return "```json\n" + JSON.stringify(payload, null, 2) + "\n```";
  } catch {
    return "";
  }
}

// ---------- Notes (result) ----------

function NotesView({
  published,
  runState,
  signedUrls,
  outputType,
  isTextual,
  onRunAgain,
  stepLabels,
}: {
  published: FlowPublished;
  runState: { kind: "done"; run: FlowRunPublic; steps: FlowRunStep[] };
  signedUrls: Record<string, { url: string }>;
  outputType: string | null;
  isTextual: boolean;
  onRunAgain: () => void;
  stepLabels: Record<string, string>;
}) {
  const { run, steps } = runState;
  const resultText = runResultText(run);
  const text = resultText?.text ?? null;
  const truncated = resultText?.truncated ?? false;
  const errorMessage = runErrorMessage(run);
  const resultFiles = runResultFiles(run);
  const success = isSuccess(run.status);
  const outputLabel = labelForOutputType(outputType);
  const finishedDate = run.finished_at
    ? new Date(run.finished_at).toLocaleDateString("sv-SE", {
        day: "numeric",
        month: "long",
      })
    : null;
  const fileCount = resultFiles.length;

  return (
    <>
      <NavBar title={`Klar · ${labelForRunStatus(run.status).toLowerCase()}`} />

      <div className="px-6 md:px-8 pt-2 md:pt-4 pb-5 w-full mx-auto max-w-3xl">
        <h1 className="text-[26px] md:text-[32px] font-semibold tracking-[-0.025em] leading-[1.15] mb-2.5">
          {published.name}
        </h1>
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 font-mono text-[10px] tracking-wider uppercase text-ink-mute">
          {finishedDate && (
            <span className="after:content-['·'] after:ml-3.5 after:text-rule last:after:hidden">
              {finishedDate}
            </span>
          )}
          <span className="after:content-['·'] after:ml-3.5 after:text-rule last:after:hidden">
            v{published.published_version}
          </span>
          {fileCount > 0 && (
            <span className="after:content-['·'] after:ml-3.5 after:text-rule last:after:hidden">
              {fileCount} {fileCount === 1 ? "fil" : "filer"}
            </span>
          )}
        </div>
      </div>

      <div className="px-6 md:px-8 pb-6 flex-1 w-full mx-auto max-w-3xl">
        {errorMessage && (
          <div className="paper-card p-4 mb-4 border-accent/30">
            <div className="eyebrow-sm text-accent mb-1">Fel</div>
            <p className="text-[14px] text-ink">{errorMessage}</p>
          </div>
        )}

        {success && text && (
          <article
            className="
              prose prose-stone max-w-none
              prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-ink
              prose-h1:text-[22px] prose-h2:text-[18px] prose-h3:text-[15px]
              prose-p:text-[14px] prose-p:leading-[1.6] prose-p:text-ink
              prose-li:text-[14px] prose-li:leading-[1.55] prose-li:text-ink
              prose-strong:text-ink prose-strong:font-semibold
              prose-em:text-ink-soft prose-em:not-italic
              prose-a:text-accent prose-a:no-underline hover:prose-a:underline
              prose-code:font-mono prose-code:text-[12px]
              prose-code:before:hidden prose-code:after:hidden
              prose-code:bg-bg-2 prose-code:px-1 prose-code:py-0.5 prose-code:rounded
              prose-pre:bg-ink prose-pre:text-paper prose-pre:rounded-xl
              prose-blockquote:not-italic prose-blockquote:text-ink-soft prose-blockquote:border-accent prose-blockquote:font-normal
              prose-table:text-[13px]
              prose-hr:border-rule-soft
            "
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </article>
        )}

        {/* Visa raw JSON-output bara om vi förväntar oss text men ingen kunde extraheras */}
        {success && truncated && (
          <p className="text-[13px] text-ink-soft mt-3">
            Texten är för lång för att visas i sin helhet — ladda ner filen nedan
            för hela resultatet.
          </p>
        )}

        {/* För binär output (DOCX/PDF/etc): liten beskrivning ovanför fil-listan */}
        {success && !isTextual && fileCount > 0 && outputLabel && (
          <p className="text-[14px] text-ink-soft mb-2">
            Det här flödet skapade ett <span className="text-ink">{outputLabel}</span>
            {fileCount === 1 ? "" : ` (${fileCount} filer)`}.
          </p>
        )}

        {!success && !errorMessage && (
          <p className="text-[14px] text-ink-soft">
            Körningen avslutades med status:{" "}
            <span className="text-ink">{labelForRunStatus(run.status)}</span>.
          </p>
        )}

        {fileCount > 0 && (
          <section className={isTextual ? "mt-6" : ""}>
            <div className="flex items-center justify-between mb-2.5">
              <div className="eyebrow-sm">Genererade filer</div>
              <div className="bg-ink text-paper px-2 py-0.5 rounded-full text-[9px] font-mono tracking-wider">
                {fileCount}
              </div>
            </div>
            <ul className="divide-y divide-rule-soft">
              {resultFiles.map((a) => {
                const url = signedUrls[a.file_id]?.url;
                const name = a.name || a.file_id;
                const purged = !isResultFileDownloadable(a);
                return (
                  <li
                    key={a.file_id}
                    className="flex items-center justify-between py-3"
                  >
                    <div className="flex-1 min-w-0 pr-3">
                      <div className="text-[14px] truncate">{name}</div>
                      {a.size != null && (
                        <div className="text-[11px] text-ink-mute mt-0.5 font-mono">
                          {formatBytes(a.size)}
                        </div>
                      )}
                    </div>
                    {purged ? (
                      <span className="inline-flex items-center gap-2 rounded-full border border-rule-soft bg-bg-2/50 text-ink-mute px-4 py-2 text-[13px] shrink-0">
                        Borttagen
                      </span>
                    ) : url ? (
                      <a
                        href={url}
                        download={name}
                        className="inline-flex items-center gap-2 rounded-full bg-ink text-paper px-4 py-2 text-[13px] font-medium tracking-tight shadow-sm transition-all hover:bg-ink/90 active:scale-[0.97] shrink-0"
                      >
                        <Download className="h-4 w-4" strokeWidth={2} />
                        Ladda ner
                      </a>
                    ) : (
                      <span className="inline-flex items-center gap-2 rounded-full border border-rule-soft bg-bg-2/50 text-ink-mute px-4 py-2 text-[13px] font-mono tracking-wider shrink-0">
                        <span
                          aria-hidden
                          className="inline-block h-1.5 w-1.5 rounded-full bg-ink-mute lyssna-live-pulse"
                        />
                        genererar
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {steps.length > 0 && (
          <details className="paper-card p-4 mt-6">
            <summary className="cursor-pointer eyebrow-sm hover:text-ink transition-colors">
              Visa stegdetaljer · {steps.length}
            </summary>
            <div className="mt-3">
              <StepProgress steps={steps} stepLabels={stepLabels} />
            </div>
          </details>
        )}
      </div>

      <footer className="sticky bottom-0 px-5 md:px-8 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-rule-soft bg-paper">
        <div className="flex gap-2.5 w-full mx-auto max-w-3xl">
          <Button
            type="button"
            variant="secondary"
            color="vattjom"
            onClick={onRunAgain}
            leftIcon={<Share2 className="h-3.5 w-3.5" strokeWidth={1.8} />}
            className="flex-1"
          >
            Kör igen
          </Button>
          <Link href="/flows" className="flex-[1.6]">
            <Button
              as="span"
              color="vattjom"
              variant="primary"
              leftIcon={<Send className="h-3.5 w-3.5" strokeWidth={1.8} />}
              className="w-full"
            >
              Klart
            </Button>
          </Link>
        </div>
      </footer>
    </>
  );
}

// ---------- Helpers ----------

const SUCCESS_STATUSES = new Set(["succeeded", "completed", "success", "done"]);
const FAILURE_STATUSES = new Set(["failed", "error", "errored"]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "aborted"]);
// "awaiting_review" är ett non-terminal status i nya Eneo-specen (human-in-the-loop).
// Pollingen behöver inte ändras — men när vi bygger UI för review checkpoints
// ska vi sluta visa "kör" och istället visa pending review.

function isSuccess(status: string): boolean {
  return SUCCESS_STATUSES.has(status.toLowerCase());
}

function isTerminal(status: string): boolean {
  const s = status.toLowerCase();
  return (
    SUCCESS_STATUSES.has(s) ||
    FAILURE_STATUSES.has(s) ||
    CANCELLED_STATUSES.has(s)
  );
}

function labelForRunStatus(status: string): string {
  const s = status.toLowerCase();
  if (SUCCESS_STATUSES.has(s)) return "Lyckades";
  if (FAILURE_STATUSES.has(s)) return "Misslyckades";
  if (CANCELLED_STATUSES.has(s)) return "Avbröts";
  if (s === "running" || s === "in_progress") return "Bearbetar…";
  if (s === "queued" || s === "pending") return "I kö";
  return status;
}

function labelForUploadTimeout(reason: RuntimeUploadTimeoutEvent["reason"]): string {
  switch (reason) {
    case "not_started":
      return "Uppladdningen startade inte i tid. Kontrollera nätverket och försök igen.";
    case "stalled":
      return "Uppladdningen verkar ha stannat. Kontrollera nätverket och försök igen.";
    case "server_not_responding":
      return "Filen skickades, men servern svarade inte i tid. Försök igen innan du spelar in på nytt.";
  }
}

function labelForOutputType(outputType: string | null | undefined): string | null {
  if (!outputType) return null;
  const t = outputType.toLowerCase();
  switch (t) {
    case "docx":
      return "Word-dokument (DOCX)";
    case "pdf":
      return "PDF-dokument";
    case "xlsx":
      return "Excel-dokument (XLSX)";
    case "pptx":
      return "PowerPoint-dokument (PPTX)";
    case "image":
    case "png":
    case "jpg":
    case "jpeg":
      return "Bild";
    case "audio":
      return "Ljudfil";
    case "video":
      return "Videofil";
    case "text":
    case "markdown":
      return "Text";
    case "json":
      return "JSON-data";
    default:
      return outputType.toUpperCase();
  }
}

function labelForStepStatus(status: string): string {
  const s = status.toLowerCase();
  if (SUCCESS_STATUSES.has(s)) return "Klar";
  if (FAILURE_STATUSES.has(s)) return "Misslyckades";
  if (CANCELLED_STATUSES.has(s)) return "Avbruten";
  if (s === "running" || s === "in_progress") return "Kör…";
  if (s === "queued" || s === "pending") return "I kö";
  return status;
}
