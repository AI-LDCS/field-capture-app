import { useEffect, useRef, useState, type RefObject } from "react";
import { CONFIG } from "@shared/config.ts";
import { type PreflightEval, type PreflightSample, evaluatePreflight, preflightProgress } from "@shared/preflight.ts";
import type { AssignmentDetail, PreflightOutcome } from "@shared/types.ts";
import { api } from "../api.ts";
import { fmtBytes } from "../ui.tsx";
import { openCamera, storageCheck } from "./lib/camera.ts";
import { fakeGps, gpsSource } from "./lib/gps.ts";
import { closeCamera, getSession, setSession, useSession } from "./lib/session.ts";
import { useSettings } from "./lib/settings.ts";

export type StorageInfo = Awaited<ReturnType<typeof storageCheck>>;

/** Free space, read once the camera is open, and again when the worker has cleared some. */
export function useStorage(cameraOpen: boolean): { storage: StorageInfo | null; recheck: () => void } {
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!cameraOpen) {
      setStorage(null);
      return;
    }
    let dead = false;
    void storageCheck().then((s) => {
      if (!dead) setStorage(s);
    });
    return () => {
      dead = true;
    };
  }, [cameraOpen, nonce]);
  return { storage, recheck: () => setNonce((n) => n + 1) };
}

/** Opens the camera into the session. `wanted` turns false when the worker leaves while the permission prompt is up. */
export function useCameraOpener(wanted: RefObject<boolean>) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const opening = useRef(false);
  const open = async () => {
    if (opening.current || getSession().camera) return;
    opening.current = true;
    setBusy(true);
    setErr("");
    try {
      const cam = await openCamera();
      if (wanted.current) setSession({ camera: cam });
      else cam.stop();
    } catch (e: any) {
      setErr(e.name === "NotAllowedError" ? "Camera is blocked. Allow it for this site, then try again." : e.message);
    } finally {
      opening.current = false;
      setBusy(false);
    }
  };
  return { open, err, busy };
}

function gpsHint(latestAcc: number | undefined, ev: PreflightEval | null) {
  if (latestAcc === undefined) return "Finding your location… Allow it if the phone asks.";
  if (latestAcc > CONFIG.preflight.targetAccuracyM) return "Weak signal. Move to open sky.";
  if (ev?.spreadM != null && ev.spreadM > CONFIG.preflight.maxSpreadM) return "Position is moving. Stand still.";
  return "Good signal. Stand still.";
}

/** Moves on by itself as soon as the readings are steady. */
function GpsCheck({ assignmentId, onDone }: { assignmentId: string; onDone: (o: PreflightOutcome) => void }) {
  const s = useSettings();
  const [ev, setEv] = useState<PreflightEval | null>(null);
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState("");
  // A fix, or an error other than "denied", proves location is allowed. Until then the prompt may still be
  // unanswered, and skipping would be a way past it.
  const [allowed, setAllowed] = useState(false);
  const samples = useRef<PreflightSample[]>([]);
  const startAt = useRef(0);
  const finished = useRef(false);

  const finish = async (result: "passed" | "skipped", note?: string) => {
    if (finished.current) return;
    finished.current = true;
    const accs = samples.current.map((x) => x.acc);
    const outcome: PreflightOutcome = {
      result,
      durationMs: Date.now() - startAt.current,
      samples: samples.current.length,
      bestAccuracyM: accs.length ? Math.min(...accs) : null,
      note,
    };
    await api.myPreflight(assignmentId, outcome).catch(() => {});
    onDone(outcome);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    samples.current = [];
    finished.current = false;
    startAt.current = Date.now();
    if (s.fake) fakeGps.coldStart();
    const off = gpsSource().subscribe(
      (f) => {
        samples.current = [...samples.current.slice(-59), f];
        setErr("");
        setAllowed(true);
      },
      (msg, denied) => {
        setErr(msg);
        if (!denied) setAllowed(true);
      },
    );
    const timer = setInterval(() => {
      const now = Date.now();
      const e = evaluatePreflight(samples.current, now);
      setEv(e);
      setProgress(e.stable ? 1 : Math.min(0.95, preflightProgress(samples.current, now))); // drifting can still hold back a full bar
      setElapsed(now - startAt.current);
      if (e.stable) void finishRef.current("passed");
    }, 500);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [s.fake]);

  const latest = samples.current.at(-1);
  const leftS = Math.max(0, Math.ceil(s.preflightTimeoutS - elapsed / 1000));
  return (
    <>
      <div className="row between gps-top">
        <div className="gps-big">{latest ? `±${latest.acc.toFixed(0)} m` : "–"}</div>
        {leftS > 0 && (
          <span className="small muted gps-time">
            Time left {Math.floor(leftS / 60)}:{String(leftS % 60).padStart(2, "0")}
          </span>
        )}
      </div>
      <div className="meter">
        <div style={{ width: `${progress * 100}%` }} />
      </div>
      {err ? <p className="err">{err}</p> : <p>{gpsHint(latest?.acc, ev)}</p>}
      {allowed && elapsed >= s.preflightTimeoutS * 1000 && (
        <div className="warn-box">
          <p>GPS has not settled. If you skip, an administrator will review this assignment.</p>
          <button className="danger" onClick={() => void finish("skipped", ev?.reason)}>
            Skip GPS check
          </button>
        </div>
      )}
    </>
  );
}

function CameraCheck({
  storage,
  recheck,
  open,
  err,
  busy,
}: {
  storage: StorageInfo | null;
  recheck: () => void;
  open: () => Promise<void>;
  err: string;
  busy: boolean;
}) {
  const { camera } = useSession();
  const vid = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (vid.current) vid.current.srcObject = camera?.stream ?? null;
  }, [camera]);

  if (!camera) {
    if (busy) return <p className="muted">Opening camera…</p>;
    return (
      <>
        {err && <p className="err">{err}</p>}
        <button onClick={() => void open()}>{err ? "Try again" : "Open camera"}</button>
      </>
    );
  }
  return (
    <>
      <video ref={vid} className="preview" autoPlay muted playsInline />
      {!camera.fake && camera.facing !== "environment" && <p className="small err">Rear camera not confirmed.</p>}
      {!storage && <p className="small muted">Checking storage…</p>}
      {storage?.ok && <p className="ok small">✓ {storage.quota ? `${fmtBytes(storage.free)} free` : "Storage ok"}</p>}
      {storage && !storage.ok && (
        <>
          <p className="err">
            Only {fmtBytes(storage.free)} free, need {fmtBytes(CONFIG.recording.minFreeBytes)}. Free up space on the phone.
          </p>
          <button onClick={recheck}>Check again</button>
        </>
      )}
    </>
  );
}

/** The sub-page behind Start Recording. The Start recording button here is the only way to begin a recording. */
export function Onboard(props: {
  run: AssignmentDetail;
  pre: PreflightOutcome | null;
  preflightDone: boolean;
  gpsDenied: boolean;
  storage: StorageInfo | null;
  recheck: () => void;
  camera: { open: () => Promise<void>; err: string; busy: boolean };
  why: string;
  onPreflight: (o: PreflightOutcome) => void;
  onRedo: () => void;
  onStart: () => void;
}) {
  const { run, pre, preflightDone, gpsDenied, storage, recheck, camera: cam, why, onPreflight, onRedo, onStart } = props;
  const { camera, active } = useSession();
  const s = useSettings();
  const cameraOk = preflightDone && !gpsDenied && !!camera && !!storage?.ok; // the camera opens early, but this step comes second
  const walkable = run.segments.filter((x) => x.status !== "skipped");

  useEffect(() => {
    // dev tools: fake mode was switched
    if (camera && camera.fake !== s.fake && !active) {
      closeCamera();
      void cam.open();
    }
  }, [s.fake]);

  return (
    <>
      <a className="back small" href={`#/assignment/${run.id}`}>
        ‹ {run.route.name}
      </a>

      <section className="card">
        {gpsDenied ? (
          <>
            <h3>
              <span className="step-dot bad">!</span> GPS
            </h3>
            <p className="err">Location is blocked, so you cannot record. Allow it for this site in your browser settings.</p>
            <button onClick={() => location.reload()}>Try again</button>
          </>
        ) : preflightDone ? (
          <div className="row between check-head">
            <h3>
              <span className="step-dot done">✓</span> GPS{" "}
              {pre!.result === "skipped" ? "skipped" : `±${pre!.bestAccuracyM?.toFixed(0) ?? "?"} m`}
            </h3>
            <button className="ghost small" onClick={onRedo}>
              Redo
            </button>
          </div>
        ) : (
          <>
            <h3>
              <span className="step-dot">1</span> GPS
            </h3>
            <GpsCheck assignmentId={run.id} onDone={onPreflight} />
          </>
        )}
      </section>

      <section className={`card${preflightDone && !gpsDenied ? "" : " todo"}`}>
        <h3>
          <span className={`step-dot${cameraOk ? " done" : ""}`}>{cameraOk ? "✓" : "2"}</span> Camera &amp; storage
        </h3>
        {preflightDone && !gpsDenied && <CameraCheck storage={storage} recheck={recheck} open={cam.open} err={cam.err} busy={cam.busy} />}
      </section>

      <button className="cta" disabled={!!why} onClick={onStart}>
        Start recording
      </button>
      {why ? (
        <p className="muted small center">{why}</p>
      ) : (
        <p className="muted small center">Keep this page open and the screen on. Recording stops if you leave.</p>
      )}
      {s.fake && (
        <div className="row wrap">
          <button className="ghost" onClick={() => fakeGps.walk(walkable.map((x) => x.coords))}>
            Fake: walk all segments
          </button>
          <button className="ghost" onClick={() => fakeGps.walk(walkable.filter((x) => x.required).map((x) => x.coords))}>
            Fake: walk required only
          </button>
          <button className="ghost" onClick={() => fakeGps.stopWalking()}>
            Fake: stop
          </button>
        </div>
      )}
    </>
  );
}
