import { useEffect, useRef, useState } from "react";
import { Circle, CircleMarker, MapContainer, Polyline, useMap } from "react-leaflet";
import { CONFIG } from "@shared/config.ts";
import { coverageMask, distToLineM } from "@shared/geo.ts";
import { type PreflightEval, type PreflightSample, evaluatePreflight } from "@shared/preflight.ts";
import type { AssignmentDetail, LngLat, PreflightOutcome } from "@shared/types.ts";
import { api } from "../api.ts";
import { Badge, Tiles, fmtBytes, ll } from "../ui.tsx";
import { openCamera, storageCheck } from "./camera.ts";
import { type Fix, fakeGps, gpsSource } from "./gps.ts";
import { getAssignment, gpsOf, putAssignment } from "./localdb.ts";
import { DevPanel, LocalRecordings, Recovery, useLocalRecordings } from "./localui.tsx";
import RecordingView, { type Mask } from "./RecordingView.tsx";
import { startRecording } from "./recorder.ts";
import { closeCamera, setSession, useSession } from "./session.ts";
import { devToolsOn, getSettings, useSettings } from "./settings.ts";

const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

function FitOnce({ run }: { run: AssignmentDetail }) {
  const map = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    const pts = run.segments.flatMap((s) => s.coords.map(ll));
    if (pts.length) { map.fitBounds(pts, { padding: [30, 30] }); done.current = true; }
  }, [map, run]);
  return null;
}

// ---------- step 1: GPS readiness ----------
function Preflight({ assignmentId, onDone }: { assignmentId: string; onDone: (o: PreflightOutcome) => void }) {
  const s = useSettings();
  const [started, setStarted] = useState(false);
  const [ev, setEv] = useState<PreflightEval | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState("");
  const samples = useRef<PreflightSample[]>([]);
  const startAt = useRef(0);
  const finished = useRef(false);

  const finish = async (result: "passed" | "skipped", note?: string) => {
    if (finished.current) return;
    finished.current = true;
    const accs = samples.current.map((x) => x.acc);
    const outcome: PreflightOutcome = {
      result, durationMs: Date.now() - startAt.current, samples: samples.current.length,
      bestAccuracyM: accs.length ? Math.min(...accs) : null, note,
    };
    await api.myPreflight(assignmentId, outcome).catch(() => {});
    onDone(outcome);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    if (!started) return;
    samples.current = [];
    finished.current = false;
    startAt.current = Date.now();
    if (s.fake) fakeGps.coldStart();
    const off = gpsSource().subscribe((f) => { samples.current = [...samples.current.slice(-59), f]; setErr(""); }, setErr);
    const timer = setInterval(() => {
      const now = Date.now();
      const e = evaluatePreflight(samples.current, now);
      setEv(e);
      setElapsed(now - startAt.current);
      if (e.stable) void finishRef.current("passed");
    }, 500);
    return () => { off(); clearInterval(timer); };
  }, [started]);

  const timeoutMs = s.preflightTimeoutS * 1000;
  const latest = samples.current.at(-1);
  if (!started) {
    return (
      <>
        <p>Checks that GPS is accurate and steady before you start. Stand still outside with a clear view of the sky.</p>
        <button onClick={() => setStarted(true)}>Start GPS check</button>
      </>
    );
  }
  return (
    <>
      <div className="meter"><div style={{ width: `${Math.min(100, (elapsed / timeoutMs) * 100)}%` }} /></div>
      <p className="small muted">
        {mmss(elapsed)} / {mmss(timeoutMs)} · latest accuracy: {latest ? `${latest.acc.toFixed(0)} m` : "waiting for a fix…"} · target ≤ {CONFIG.preflight.targetAccuracyM} m
      </p>
      <p>{ev?.reason ?? "collecting samples…"} {ev && <span className="muted small">({ev.samplesInWindow} samples in window)</span>}</p>
      {err && <p className="err">{err}</p>}
      {elapsed >= timeoutMs && (
        <div className="warn-box">
          <p>GPS has not settled after {s.preflightTimeoutS} s. You can skip the check. This is recorded and the assignment will be reviewed.</p>
          <button className="danger" onClick={() => void finish("skipped", ev?.reason)}>Skip GPS check</button>
        </div>
      )}
    </>
  );
}

// ---------- step 2: camera + storage ----------
function CameraCheck() {
  const { camera } = useSession();
  const [st, setSt] = useState<Awaited<ReturnType<typeof storageCheck>> | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const vid = useRef<HTMLVideoElement>(null);

  useEffect(() => { if (vid.current) vid.current.srcObject = camera?.stream ?? null; }, [camera]);
  useEffect(() => { if (camera) void storageCheck().then(setSt); }, [camera]);

  const open = async () => {
    setBusy(true);
    setErr("");
    try { setSession({ camera: await openCamera() }); }
    catch (e: any) { setErr(`${e.name ?? "Error"}: ${e.message}`); }
    finally { setBusy(false); }
  };

  if (!camera) {
    return (
      <>
        <p>Opens the camera (rear if available) and checks free storage.</p>
        <button onClick={() => void open()} disabled={busy}>Check camera &amp; storage</button>
        {err && <p className="err">{err}</p>}
      </>
    );
  }
  return (
    <>
      <video ref={vid} className="preview" autoPlay muted playsInline />
      <p className="small">
        {camera.label || "camera"} · {camera.width}×{camera.height} · facing: {camera.facing ?? "unknown"}
        {!camera.fake && camera.facing !== "environment" && <span className="err"> — rear camera not confirmed (normal on a laptop)</span>}
      </p>
      {st && (
        <p className={`small ${st.ok ? "" : "err"}`}>
          Storage: {fmtBytes(st.free)} free of {fmtBytes(st.quota)} · persistent: {st.persisted ? "yes" : "no (the browser may delete it)"}
          {!st.ok && ` — need at least ${fmtBytes(CONFIG.recording.minFreeBytes)}`}
        </p>
      )}
      <button className="ghost" onClick={closeCamera}>Close camera</button>
    </>
  );
}

// ---------- step 3: record ----------
function RecordPanel({ run, preflightDone }: { run: AssignmentDetail; preflightDone: boolean }) {
  const { camera, active, activeAssignmentId, lastStop } = useSession();
  const s = useSettings();
  const local = useLocalRecordings(run.id);
  const [err, setErr] = useState("");
  const interrupted = local.some((r) => r.status === "interrupted");
  const mine = active && activeAssignmentId === run.id;

  const start = async () => {
    setErr("");
    try {
      setSession({ lastStop: null });
      const ar = await startRecording({
        assignmentId: run.id, simulated: getSettings().fake || !!camera?.fake, stream: camera!.stream, gps: gpsSource(),
        onChange: () => {},
        onStopped: (reason) => { setSession({ active: null, activeAssignmentId: null, lastStop: reason }); fakeGps.stopWalking(); },
      });
      setSession({ active: ar, activeAssignmentId: run.id });
    } catch (e: any) { setErr(e.message); }
  };

  const why = !preflightDone ? "Finish the GPS check first"
    : !camera ? "Check the camera first"
    : interrupted ? "Finalize the cut-off recording first"
    : run.status === "completed" ? "This assignment is completed" : "";
  const walkable = run.segments.filter((x) => x.status !== "skipped");

  return (
    <>
      {lastStop && <p className="warn-box">Last recording stopped: {lastStop}. Start a new recording to continue.</p>}
      <button onClick={() => void start()} disabled={!!why || !!mine}>Start recording</button>
      {why && <p className="muted small">{why}</p>}
      {err && <p className="err">{err}</p>}
      <p className="muted small">Keep the screen on and this page open. Recording stops if the page is hidden. Uploads happen in the background.</p>
      {s.fake && (
        <div className="row wrap">
          <button className="ghost" onClick={() => fakeGps.walk(walkable.map((x) => x.coords))}>Fake: walk all segments</button>
          <button className="ghost" onClick={() => fakeGps.walk(walkable.filter((x) => x.required).map((x) => x.coords))}>Fake: walk required only</button>
          <button className="ghost" onClick={() => fakeGps.stopWalking()}>Fake: stop</button>
        </div>
      )}
    </>
  );
}

// ---------- page ----------
export default function WorkerRun({ id }: { id: string }) {
  const [run, setRun] = useState<AssignmentDetail | null>(null);
  const [offline, setOffline] = useState(false);
  const [fix, setFix] = useState<Fix | null>(null);
  const [trail, setTrail] = useState<LngLat[]>([]);
  const [localCov, setLocalCov] = useState<number[]>([]);
  const [masks, setMasks] = useState<Mask[]>([]);
  const [preflightLocal, setPreflightLocal] = useState<PreflightOutcome | null>(null);
  const [redo, setRedo] = useState(false);
  const [skipReason, setSkipReason] = useState("");
  const [msg, setMsg] = useState("");
  const s = useSettings();
  const session = useSession();
  const local = useLocalRecordings(id);

  const load = async () => {
    try {
      const d = await api.myAssignment(id);
      setRun(d);
      setOffline(false);
      void putAssignment({ id, detail: d }).catch(() => {});
    } catch {
      setOffline(true);
      const l = await getAssignment(id).catch(() => undefined);
      if (l) setRun((cur) => cur ?? l.detail);
    }
  };
  useEffect(() => {
    void load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [id]);

  useEffect(() => {
    if (s.fake && run?.segments[0]) fakeGps.setStart(run.segments[0].coords[0]);
  }, [s.fake, run?.id]);

  useEffect(() => gpsSource().subscribe((f) => {
    setFix(f);
    setTrail((t) => [...t.slice(-400), [f.lng, f.lat]]);
  }), [s.fake]);

  // coverage shown on the phone = what the server verified (its GPS, since the local copy is deleted) + what is still here
  const runRef = useRef<AssignmentDetail | null>(null);
  runRef.current = run;
  const serverRows = useRef(new Map<string, { lat: number; lng: number; acc: number }[]>());
  useEffect(() => {
    if (!run) return;
    let dead = false;
    const calc = async () => {
      const cur = runRef.current;
      if (!cur) return;
      const verified = cur.recordings.filter((r) => r.status === "server_verified");
      for (const r of verified) {
        if (!serverRows.current.has(r.id)) {
          try { serverRows.current.set(r.id, await api.myRecordingGps(r.id)); } catch { /* retry next tick */ }
        }
      }
      const verifiedIds = new Set(verified.map((r) => r.id));
      const localRows = await Promise.all(local.filter((r) => !verifiedIds.has(r.id)).map((r) => gpsOf(r.id).catch(() => [])));
      const points = [...verified.flatMap((r) => serverRows.current.get(r.id) ?? []), ...localRows.flat()];
      const m = cur.segments.map((x) => coverageMask(x.coords, points, CONFIG.coverage));
      if (dead) return;
      setMasks(m);
      setLocalCov(m.map((x) => (x.samples.length ? x.covered.filter(Boolean).length / x.samples.length : 0)));
    };
    void calc();
    const t = setInterval(calc, 1500);
    return () => { dead = true; clearInterval(t); };
  }, [run?.id, local.length]);

  if (!run) return <p>Loading…</p>;

  const pre = run.preflight ?? preflightLocal;
  const preflightDone = !!pre && !redo;
  const cov = (i: number) => Math.max(run.segments[i].coverage, localCov[i] ?? 0);

  if (session.active && session.activeAssignmentId === id) {
    return (
      <RecordingView run={run} cov={run.segments.map((_, i) => cov(i))} masks={masks} fix={fix} trail={trail}
        camera={session.camera} active={session.active}
        onSkip={async (segId) => { try { setRun(await api.mySkip(id, segId, "skipped while recording")); } catch { /* shown on the next refresh */ } }} />
    );
  }

  let nearest = Infinity;
  let nearestIdx = -1;
  if (fix) {
    run.segments.forEach((sg, i) => {
      const d = distToLineM([fix.lng, fix.lat], sg.coords);
      if (d < nearest) { nearest = d; nearestIdx = i; }
    });
  }
  const requiredTotal = run.segments.filter((x) => x.required).length;
  const requiredDone = run.segments.filter((x, i) => x.required && (x.status === "completed" || cov(i) >= x.minCoverageRatio)).length;

  const act = async (fn: () => Promise<AssignmentDetail>) => {
    setMsg("");
    try { setRun(await fn()); } catch (e: any) { setMsg(e.message); }
  };

  return (
    <>
      <section className="card">
        <div className="row between">
          <h3>{run.route.name}</h3>
          <Badge s={run.status} />
        </div>
        <p className="small muted">
          {requiredDone}/{requiredTotal} required segments covered · {offline ? <span className="err">server unreachable, showing the saved copy</span> : "online"}
        </p>
        {run.reasons.length > 0 && <ul className="small">{run.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      </section>

      <Recovery assignmentId={id} />

      <div className="map">
        <MapContainer center={[13.7563, 100.5018]} zoom={16} style={{ height: "100%" }}>
          <Tiles />
          <FitOnce run={run} />
          {run.segments.map((sg, i) => (
            <Polyline key={sg.id} positions={sg.coords.map(ll)}
              pathOptions={{
                color: sg.status === "skipped" ? "#9ca3af" : cov(i) >= sg.minCoverageRatio ? "#16a34a" : sg.required ? "#1d4ed8" : "#ea580c",
                weight: 6, dashArray: sg.required ? undefined : "8 8",
              }} />
          ))}
          {trail.length > 1 && <Polyline positions={trail.map(ll)} pathOptions={{ color: "#111827", weight: 2 }} />}
          {fix && <Circle center={[fix.lat, fix.lng]} radius={fix.acc} pathOptions={{ color: "#2563eb", weight: 1, fillOpacity: 0.1 }} />}
          {fix && <CircleMarker center={[fix.lat, fix.lng]} radius={7} pathOptions={{ color: "#fff", fillColor: "#2563eb", fillOpacity: 1, weight: 2 }} />}
        </MapContainer>
      </div>
      <p className="small muted">
        {fix ? `GPS ±${fix.acc.toFixed(0)} m` : "No GPS fix yet"}
        {fix && nearestIdx >= 0 && ` · ${nearest.toFixed(0)} m from segment #${nearestIdx + 1}`}
      </p>

      <section className="card">
        <h3>1 · GPS check {preflightDone && <span className="ok">✓ {pre!.result}</span>}</h3>
        {preflightDone ? (
          <div className="row between">
            <span className="small muted">{pre!.samples} samples · best ±{pre!.bestAccuracyM?.toFixed(0) ?? "?"} m · {mmss(pre!.durationMs)}</span>
            {run.status !== "completed" && <button className="ghost" onClick={() => setRedo(true)}>Redo</button>}
          </div>
        ) : (
          <Preflight assignmentId={id} onDone={(o) => { setPreflightLocal(o); setRedo(false); void load(); }} />
        )}
      </section>

      <section className="card">
        <h3>2 · Camera &amp; storage</h3>
        <CameraCheck />
      </section>

      <section className="card">
        <h3>3 · Record</h3>
        <RecordPanel run={run} preflightDone={preflightDone} />
      </section>

      <section className="card">
        <h3>Segments</h3>
        {run.segments.map((sg, i) => {
          const c = cov(i);
          const done = c >= sg.minCoverageRatio && sg.status !== "skipped";
          return (
            <div key={sg.id} className="seg">
              <div className="row between">
                <span>#{i + 1} <Badge s={sg.required ? "required" : "optional"} /> <Badge s={done ? "completed" : sg.status} /></span>
                {!sg.required && run.status !== "completed" && !done && (sg.status === "skipped"
                  ? <button className="ghost" onClick={() => void act(() => api.myUnskip(id, sg.id))}>Undo skip</button>
                  : <button className="ghost" onClick={() => void act(() => api.mySkip(id, sg.id, skipReason))}>Skip</button>)}
              </div>
              <div className="meter"><div style={{ width: `${c * 100}%` }} /><i style={{ left: `${sg.minCoverageRatio * 100}%` }} /></div>
              <div className="small muted">{(c * 100).toFixed(0)}% covered · need {(sg.minCoverageRatio * 100).toFixed(0)}%{sg.skipReason && ` · skipped: ${sg.skipReason}`}</div>
            </div>
          );
        })}
        {run.segments.some((x) => !x.required) && <input placeholder="Reason for skipping (optional)" value={skipReason} onChange={(e) => setSkipReason(e.target.value)} />}
        {msg && <p className="err">{msg}</p>}
      </section>

      <LocalRecordings assignmentId={id} />

      <section className="card">
        <h3>Finish</h3>
        <p className="small muted">The server checks the uploads, the GPS and the coverage, then decides. It is not marked done on this phone.</p>
        <button onClick={() => void act(() => api.myFinish(id))} disabled={run.status === "completed"}>Finish &amp; check with the server</button>
        <p className="small">Recordings on the server: {run.recordings.map((r) => r.status === "server_verified" ? "verified" : "uploading").join(", ") || "none"}</p>
      </section>

      {devToolsOn() && <DevPanel />}
    </>
  );
}
