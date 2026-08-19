"use client";

import {
  MoreHorizontal,
  Mic,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  baseMimetype,
  extensionForAudioMime,
  formatBytes,
  pickSupportedAudioMimetype,
} from "@/lib/upload";

type WakeLockSentinelLike = {
  release: () => Promise<void>;
};

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
};

interface Props {
  acceptedMimetypes?: string[];
  maxBytes?: number;
  onChange: (blob: Blob | null, filename: string | null) => void;
  onRecordingChange?: (recording: boolean) => void;
  /** Optional title shown above timer while recording (e.g. flow name) */
  title?: string;
  /** Optional subtitle (e.g. flow type) */
  subtitle?: string;
  /** Whether to render the big landing record button. If false, parent shows it. */
  variant?: "default" | "compact";
}

const RECORDING_CHUNK_MS = 10_000;

function pickMimetype(accepted: string[] | undefined): string | null {
  if (typeof window === "undefined" || !("MediaRecorder" in window)) return null;
  return pickSupportedAudioMimetype(accepted, (mime) =>
    MediaRecorder.isTypeSupported(mime),
  );
}

const NUM_BARS = 36;

export function AudioRecorder({
  acceptedMimetypes,
  maxBytes,
  onChange,
  onRecordingChange,
  title,
  subtitle,
}: Props) {
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [recordedBytes, setRecordedBytes] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const recordedBytesRef = useRef(0);
  const sizeLimitExceededRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const accumulatedRef = useRef<number>(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const barsRef = useRef<Array<HTMLDivElement | null>>([]);
  const liveValuesRef = useRef<number[]>(new Array(NUM_BARS).fill(0));
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);

  useEffect(() => {
    const mime = pickMimetype(acceptedMimetypes);
    setSupported(mime != null);
  }, [acceptedMimetypes]);

  useEffect(() => {
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopTick() {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }

  function cleanup() {
    stopTick();
    onRecordingChange?.(false);
    releaseWakeLock();
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    try {
      sourceRef.current?.disconnect();
    } catch {
      // ignore
    }
    sourceRef.current = null;
    analyserRef.current = null;
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      audioCtxRef.current.close().catch(() => {});
    }
    audioCtxRef.current = null;
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try {
        recorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }

  function reset() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setBlob(null);
    setRecordedBytes(0);
    recordedBytesRef.current = 0;
    sizeLimitExceededRef.current = false;
    setError(null);
    setElapsedMs(0);
    accumulatedRef.current = 0;
    onChange(null, null);
  }

  async function requestWakeLock() {
    try {
      const wakeLock = (navigator as NavigatorWithWakeLock).wakeLock;
      wakeLockRef.current = wakeLock ? await wakeLock.request("screen") : null;
    } catch {
      wakeLockRef.current = null;
    }
  }

  function releaseWakeLock() {
    const wakeLock = wakeLockRef.current;
    wakeLockRef.current = null;
    wakeLock?.release().catch(() => {});
  }

  async function start() {
    setError(null);
    const mime = pickMimetype(acceptedMimetypes);
    if (!mime) {
      setError(
        "Webbläsaren stöder ingen kompatibel ljudformat för det här flödet.",
      );
      return;
    }
    try {
      await requestWakeLock();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const AudioCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (AudioCtor) {
        const ctx = new AudioCtor();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.55;
        source.connect(analyser);
        audioCtxRef.current = ctx;
        sourceRef.current = source;
        analyserRef.current = analyser;
        startMeter();
      }

      // 32 kbps räcker gott för tal med opus och håller långa inspelningar
      // hanterbart stora (~22 MB/timme i stället för ~60 MB/timme vid default).
      const recorder = new MediaRecorder(stream, {
        mimeType: mime,
        audioBitsPerSecond: 32000,
      });
      recorderRef.current = recorder;
      chunksRef.current = [];
      recordedBytesRef.current = 0;
      sizeLimitExceededRef.current = false;
      setRecordedBytes(0);

      recorder.ondataavailable = (ev) => {
        if (!ev.data || ev.data.size === 0) return;
        chunksRef.current.push(ev.data);
        recordedBytesRef.current += ev.data.size;
        setRecordedBytes(recordedBytesRef.current);
        if (
          maxBytes &&
          recordedBytesRef.current > maxBytes &&
          recorder.state !== "inactive"
        ) {
          sizeLimitExceededRef.current = true;
          setError(
            `Inspelningen passerade maxgränsen (${formatBytes(maxBytes)}). Stoppar inspelningen.`,
          );
          recorder.stop();
        }
      };
      recorder.onstop = () => {
        const uploadMime = baseMimetype(mime);
        const finalBlob = new Blob(chunksRef.current, { type: uploadMime });
        chunksRef.current = [];
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;

        if (rafRef.current != null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        try {
          sourceRef.current?.disconnect();
        } catch {
          // ignore
        }
        sourceRef.current = null;
        analyserRef.current = null;
        if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
          audioCtxRef.current.close().catch(() => {});
        }
        audioCtxRef.current = null;
        clearMeter();
        setRecording(false);
        onRecordingChange?.(false);
        releaseWakeLock();

        if (sizeLimitExceededRef.current || (maxBytes && finalBlob.size > maxBytes)) {
          const maxLabel = maxBytes ? formatBytes(maxBytes) : "okänd";
          setError(
            `Inspelningen blev för stor (${formatBytes(finalBlob.size)}). Max: ${maxLabel}.`,
          );
          return;
        }

        const ext = extensionForAudioMime(mime);
        const fname = `recording-${Date.now()}.${ext}`;
        setBlob(finalBlob);
        setPreviewUrl(URL.createObjectURL(finalBlob));
        onChange(finalBlob, fname);
      };

      recorder.start(RECORDING_CHUNK_MS);
      startedAtRef.current = Date.now();
      accumulatedRef.current = 0;
      setRecording(true);
      onRecordingChange?.(true);
      setPaused(false);
      setElapsedMs(0);
      tickRef.current = setInterval(() => {
        if (startedAtRef.current != null) {
          setElapsedMs(
            accumulatedRef.current + (Date.now() - startedAtRef.current),
          );
        }
      }, 80);
    } catch (err) {
      releaseWakeLock();
      setError(
        err instanceof Error
          ? `Kunde inte starta inspelning: ${err.message}`
          : "Kunde inte starta inspelning.",
      );
    }
  }

  function stop() {
    stopTick();
    setRecording(false);
    onRecordingChange?.(false);
    setPaused(false);
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  }

  function pauseToggle() {
    const r = recorderRef.current;
    if (!r) return;
    if (r.state === "recording") {
      r.pause();
      stopTick();
      if (startedAtRef.current != null) {
        accumulatedRef.current += Date.now() - startedAtRef.current;
        startedAtRef.current = null;
      }
      setPaused(true);
    } else if (r.state === "paused") {
      r.resume();
      startedAtRef.current = Date.now();
      tickRef.current = setInterval(() => {
        if (startedAtRef.current != null) {
          setElapsedMs(
            accumulatedRef.current + (Date.now() - startedAtRef.current),
          );
        }
      }, 80);
      setPaused(false);
    }
  }

  function startMeter() {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const draw = () => {
      const a = analyserRef.current;
      if (!a) return;
      a.getByteFrequencyData(dataArray);
      const bins = dataArray.length;
      const step = Math.max(1, Math.floor(bins / NUM_BARS));
      for (let i = 0; i < NUM_BARS; i++) {
        let sum = 0;
        const start = i * step;
        const end = Math.min(start + step, bins);
        for (let k = start; k < end; k++) sum += dataArray[k];
        const avg = sum / Math.max(1, end - start);
        const norm = Math.min(1, Math.pow(avg / 255, 0.65));
        liveValuesRef.current[i] =
          liveValuesRef.current[i] * 0.55 + norm * 0.45;
        const v = liveValuesRef.current[i];
        const el = barsRef.current[i];
        if (el) {
          const minH = 4;
          const maxH = 70;
          const h = minH + v * (maxH - minH);
          el.style.height = `${h}px`;
          const distFromCenter = Math.abs(i - NUM_BARS / 2) / (NUM_BARS / 2);
          el.style.opacity = `${0.4 + (1 - distFromCenter) * 0.6}`;
        }
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
  }

  function clearMeter() {
    liveValuesRef.current = new Array(NUM_BARS).fill(0);
    barsRef.current.forEach((el) => {
      if (el) {
        el.style.height = "6px";
        el.style.opacity = "0.4";
      }
    });
  }

  if (!supported) {
    return (
      <p className="text-sm text-ink-soft">
        Webbläsaren stöder inte ljudinspelning för det här flödet. Använd
        filuppladdningen istället.
      </p>
    );
  }

  // ----- Idle (pre-recording) -----
  if (!recording && !blob) {
    return (
      <div className="flex flex-col items-center gap-7 md:gap-9 py-4 md:py-6">
        <button
          type="button"
          onClick={start}
          aria-label="Starta inspelning"
          className="relative grid place-items-center h-[116px] w-[116px] md:h-[140px] md:w-[140px] rounded-full bg-record text-paper text-[16px] md:text-[18px] font-semibold tracking-[-0.01em] transition-transform active:scale-[0.96] focus:outline-none"
          style={{
            boxShadow:
              "0 0 0 6px hsl(var(--bg)), 0 0 0 7px hsl(var(--record)), 0 18px 40px -10px hsl(var(--record) / 0.18)",
          }}
        >
          <span
            aria-hidden
            className="lyssna-pulse-ring absolute rounded-full border border-record"
            style={{ inset: 0, opacity: 0 }}
          />
          Spela in
        </button>
        <div className="eyebrow">Tryck för att börja</div>
      </div>
    );
  }

  // ----- Done (recorded) -----
  if (!recording && blob) {
    return (
      <div className="flex flex-col items-center gap-4 py-3">
        <div className="text-[13px] text-ink-soft">
          Inspelning klar · {formatBytes(blob.size)}
        </div>
        {previewUrl && (
          <audio
            src={previewUrl}
            controls
            className="w-full max-w-[300px] md:max-w-md"
          />
        )}
        <div className="text-[12px] text-ink-mute">
          Sparad som komprimerad {blob.type || "ljudfil"}
        </div>
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-2 rounded-full bg-paper border border-rule-soft px-4 py-2 text-[13px] text-ink-soft transition-colors hover:border-ink/40"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Spela in på nytt
        </button>
      </div>
    );
  }

  // ----- Recording (active or paused) -----
  const totalSec = Math.floor(elapsedMs / 1000);
  const mm = Math.floor(totalSec / 60).toString().padStart(2, "0");
  const ss = (totalSec % 60).toString().padStart(2, "0");
  const ff = Math.floor((elapsedMs % 1000) / 10).toString().padStart(2, "0");

  return (
    <div className="flex flex-col items-stretch -mx-6 px-6 md:px-8 rec-bg rounded-2xl py-5 md:py-8">
      <header className="flex items-center mb-2">
        <div className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.18em] uppercase text-record">
          <span
            aria-hidden
            className="lyssna-live-pulse h-1.5 w-1.5 rounded-full bg-record"
          />
          {paused ? "Pausad" : "Spelar in"}
        </div>
      </header>

      <div className="flex flex-col items-center justify-center px-2 pt-4 md:pt-6 pb-6">
        {(title || subtitle) && (
          <div className="text-center mb-7 md:mb-9">
            {title && (
              <div className="text-[19px] md:text-[26px] font-semibold tracking-[-0.015em] leading-tight">
                {title}
              </div>
            )}
            {subtitle && (
              <div className="font-mono text-[10px] md:text-[11px] tracking-[0.14em] uppercase text-ink-mute mt-1.5 md:mt-2">
                {subtitle}
              </div>
            )}
          </div>
        )}

        <div
          className="font-semibold tracking-[-0.045em] tabular-nums leading-none mb-7 md:mb-9 text-[84px] md:text-[112px]"
          style={{ letterSpacing: "-0.045em" }}
        >
          {mm}:{ss}
          <span className="text-[0.32em] text-ink-mute align-top ml-px">
            :{ff}
          </span>
        </div>

        <div className="text-[12px] text-ink-mute mb-4">
          {formatBytes(recordedBytes)}
          {maxBytes ? ` av ${formatBytes(maxBytes)}` : ""} · sparar i korta
          ljudsegment
        </div>

        <div className="flex items-center gap-[3px] md:gap-1 h-20 md:h-24 w-full max-w-[280px] md:max-w-md justify-center mb-2">
          {Array.from({ length: NUM_BARS }).map((_, i) => (
            <div
              key={i}
              ref={(el) => {
                barsRef.current[i] = el;
              }}
              className="w-[3px] rounded-[2px] bg-ink"
              style={{ height: "6px", opacity: 0.4 }}
              aria-hidden
            />
          ))}
        </div>
      </div>

      <div className="flex items-center justify-center gap-7 pt-4">
        <button
          type="button"
          onClick={pauseToggle}
          aria-label={paused ? "Återuppta inspelning" : "Pausa inspelning"}
          className="grid h-12 w-12 place-items-center rounded-full bg-paper border border-rule text-ink transition-colors hover:border-ink/40 focus:outline-none focus-visible:ring-4 focus-visible:ring-record/30"
        >
          {paused ? (
            <Play className="h-[18px] w-[18px]" strokeWidth={1.5} />
          ) : (
            <Pause className="h-[18px] w-[18px]" strokeWidth={1.5} />
          )}
        </button>
        <button
          type="button"
          onClick={stop}
          aria-label="Stoppa inspelning"
          className="relative grid h-[84px] w-[84px] place-items-center rounded-full bg-record transition-transform active:scale-[0.96] focus:outline-none focus-visible:ring-4 focus-visible:ring-record/30"
          style={{
            boxShadow: "0 12px 28px -8px hsl(var(--record) / 0.18)",
          }}
        >
          <span
            aria-hidden
            className="lyssna-pulse-ring absolute rounded-full border border-record"
            style={{ inset: 0, opacity: 0 }}
          />
          <span className="block h-6 w-6 rounded-[4px] bg-paper" />
        </button>
        <button
          type="button"
          aria-label="Mer"
          disabled
          className="grid h-12 w-12 place-items-center rounded-full bg-paper border border-rule text-ink-soft opacity-50"
        >
          <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={1.5} />
        </button>
      </div>

      {error && (
        <p className="text-sm text-record text-center mt-3" role="alert">
          {error}
        </p>
      )}

      {/* Hidden hint icon for screen readers — visual cue is the pulse-ring */}
      <span className="sr-only">
        <Mic /> Spelar in ljud
      </span>
    </div>
  );
}
