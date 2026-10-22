import { CONFIG } from "@shared/config.ts";
import type { GpsSource } from "./gps.ts";
import { type LocalRecording, getRecording, putChunk, putGps, putRecording } from "./localdb.ts";

export async function sha256Hex(blob: Blob): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function pickMime(): string {
  const list = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4;codecs=avc1", "video/mp4"];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}

export type RecStats = { chunks: number; bytes: number; gps: number; error: string | null; startedAt: number };
export type ActiveRecording = { id: string; stop: (reason: string) => Promise<void>; stats: () => RecStats };

/**
 * One MediaRecorder per recording. A reload can never continue it: the next recorder
 * writes a new init segment, so it must be a new recording (recovery finalizes the old one as-is).
 */
export async function startRecording(opts: {
  assignmentId: string;
  simulated: boolean;
  stream: MediaStream;
  gps: GpsSource;
  onChange: () => void;
  onStopped: (reason: string) => void;
}): Promise<ActiveRecording> {
  const id = crypto.randomUUID();
  const wanted = pickMime();
  const rec = new MediaRecorder(opts.stream, {
    ...(wanted ? { mimeType: wanted } : {}),
    videoBitsPerSecond: CONFIG.recording.videoBitsPerSecond,
  });
  const meta: LocalRecording = {
    id, assignmentId: opts.assignmentId, mime: rec.mimeType || wanted || "video/webm", simulated: opts.simulated, status: "recording",
    startedAt: Date.now(), endedAt: null, serverRegistered: false,
  };
  await putRecording(meta); // exists locally before the first byte, so recovery can find it

  const stats: RecStats = { chunks: 0, bytes: 0, gps: 0, error: null, startedAt: meta.startedAt };
  let chunkSeq = 0;
  let gpsSeq = 0;
  let chunkQ: Promise<void> = Promise.resolve();
  let gpsQ: Promise<void> = Promise.resolve();
  let stopping: Promise<void> | null = null;

  const fail = (e: unknown) => {
    stats.error = e instanceof Error ? e.message : String(e);
    opts.onChange();
    setTimeout(() => void stop("storage error"), 0);
  };

  rec.ondataavailable = (e) => {
    if (!e.data.size) return;
    const seq = chunkSeq++; // order fixed here, before any async work
    const blob = e.data;
    chunkQ = chunkQ
      .then(async () => {
        const sha256 = await sha256Hex(blob);
        await putChunk({ recordingId: id, seq, blob, size: blob.size, t: Date.now(), sha256, uploaded: false });
        stats.chunks++; // committed only after the IndexedDB transaction finished
        stats.bytes += blob.size;
        opts.onChange();
      })
      .catch(fail);
  };
  // video t=0 is when the recorder really starts; the map-on-playback feature maps video time to GPS time with it
  rec.onstart = () => {
    meta.startedAt = Date.now();
    stats.startedAt = meta.startedAt;
    void getRecording(id).then((cur) => putRecording({ ...(cur ?? meta), startedAt: meta.startedAt }));
  };
  rec.onerror = () => void stop("recorder error");

  const unsub = opts.gps.subscribe((f) => {
    const seq = gpsSeq++;
    gpsQ = gpsQ
      .then(async () => {
        await putGps({ recordingId: id, seq, t: f.t, lat: f.lat, lng: f.lng, acc: f.acc, uploaded: false });
        stats.gps++;
        opts.onChange();
      })
      .catch(fail);
  });

  let wake: WakeLockSentinel | null = null;
  try { wake = (await navigator.wakeLock?.request("screen")) ?? null; } catch { /* not allowed */ }

  const onVis = () => { if (document.hidden) void stop("page hidden"); };
  document.addEventListener("visibilitychange", onVis);

  const storageTimer = window.setInterval(async () => {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota && est.usage !== undefined && est.quota - est.usage < 100 * 1024 * 1024) void stop("low storage");
  }, 10_000);

  function stop(reason: string): Promise<void> {
    stopping ??= (async () => {
      clearInterval(storageTimer);
      document.removeEventListener("visibilitychange", onVis);
      unsub();
      if (rec.state !== "inactive") {
        await new Promise<void>((res) => { rec.onstop = () => res(); rec.stop(); });
      }
      await chunkQ;
      await gpsQ;
      try { await wake?.release(); } catch { /* ignore */ }
      await putRecording({ ...meta, status: "pending_upload", endedAt: Date.now(), stopReason: reason });
      opts.onStopped(reason);
      opts.onChange();
    })();
    return stopping;
  }

  rec.start(CONFIG.recording.timesliceMs);
  return { id, stop, stats: () => ({ ...stats }) };
}
