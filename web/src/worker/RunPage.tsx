import type L from "leaflet";
import { Fragment, useEffect, useRef, useState } from "react";
import { Circle, CircleMarker, MapContainer, Polyline, useMap } from "react-leaflet";
import { CONFIG } from "@shared/config.ts";
import { coverageMask, distToLineM } from "@shared/geo.ts";
import type { AssignmentDetail, LngLat, PreflightOutcome } from "@shared/types.ts";
import { api, isNotFound } from "../api.ts";
import { toast } from "../feedback.tsx";
import { AboveArrows, Badge, DirectionArrows, Tiles, fmtBytes, ll } from "../ui.tsx";
import { Onboard, useCameraOpener, useStorage } from "./Onboard.tsx";
import { type Fix, fakeGps, gpsSource } from "./lib/gps.ts";
import { getAssignment, gpsOf, putAssignment } from "./lib/localdb.ts";
import { DevPanel, RecordingList, Recovery, useLocalRecordings } from "./Recordings.tsx";
import RecordingView, { type Mask } from "./RecordingView.tsx";
import { startRecording } from "./lib/recorder.ts";
import { closeCamera, getSession, setSession, useSession } from "./lib/session.ts";
import { devToolsOn, getSettings, useSettings } from "./lib/settings.ts";

const routeBounds = (run: AssignmentDetail) => run.segments.flatMap((s) => s.coords.map(ll));

/** Buttons over the map that bring the view back: to the worker's position, or to the whole route. */
function RecenterButtons({ map, run, fix }: { map: L.Map | null; run: AssignmentDetail; fix: Fix | null }) {
  if (!map) return null;
  return (
    <div className="map-recenter">
      <button
        type="button"
        disabled={!fix}
        title={fix ? "Center on my location" : "No GPS fix yet"}
        onClick={() => fix && map.setView([fix.lat, fix.lng], Math.max(map.getZoom(), 18))}
      >
        ⌖ Me
      </button>
      <button
        type="button"
        title="Show the whole route"
        onClick={() => {
          const pts = routeBounds(run);
          if (pts.length) map.fitBounds(pts, { padding: [30, 30] });
        }}
      >
        Route
      </button>
    </div>
  );
}

function FitOnce({ run }: { run: AssignmentDetail }) {
  const map = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    const pts = routeBounds(run);
    if (pts.length) {
      map.fitBounds(pts, { padding: [30, 30], animate: false });
      done.current = true;
    }
  }, [map, run]);
  return null;
}

/**
 * An assignment has a home page, and behind its Start Recording button two sub-pages: onboard
 * (the checks) and record. A recording can only begin from onboard, once the checks have passed.
 */
export default function WorkerRun({ id, step }: { id: string; step: "home" | "onboard" | "record" }) {
  const [run, setRun] = useState<AssignmentDetail | null>(null);
  const [offline, setOffline] = useState(false);
  const [fix, setFix] = useState<Fix | null>(null);
  const [trail, setTrail] = useState<LngLat[]>([]);
  const [localCov, setLocalCov] = useState<number[]>([]);
  const [masks, setMasks] = useState<Mask[]>([]);
  const [preflightLocal, setPreflightLocal] = useState<PreflightOutcome | null>(null);
  const [redo, setRedo] = useState(false);
  const [skipReason, setSkipReason] = useState("");
  const s = useSettings();
  const session = useSession();
  const local = useLocalRecordings(id);
  const { storage, recheck } = useStorage(!!session.camera);
  const [gone, setGone] = useState(false);
  const [gpsDenied, setGpsDenied] = useState(false);
  const [gpsNonce, setGpsNonce] = useState(0);
  // Onboard opens only from the Start Recording tap: that is the moment the worker says they are on site, and
  // the tap is what lets the browser show the camera prompt. A reload or the forward button lands on home instead.
  const [onboarding, setOnboarding] = useState(false);
  const wantCamera = useRef(false);
  const cameraOpener = useCameraOpener(wantCamera);
  const [homeMap, setHomeMap] = useState<L.Map | null>(null);

  const load = async () => {
    try {
      const d = await api.myAssignment(id);
      setRun(d);
      setOffline(false);
      setGone(false);
      void putAssignment({ id, detail: d }).catch(() => {});
    } catch (e) {
      // the server's answer, not a lost connection: a saved copy would only hide that it is gone
      if (isNotFound(e)) {
        setOffline(false);
        setGone(true);
        return;
      }
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

  useEffect(
    () =>
      gpsSource().subscribe(
        (f) => {
          setGpsDenied(false);
          setFix(f);
          setTrail((t) => [...t.slice(-400), [f.lng, f.lat]]);
        },
        (_msg, denied) => {
          if (denied) setGpsDenied(true);
        },
      ),
    [s.fake, gpsNonce],
  );

  // Location switched off or on in the browser while the page is open: ask again, the answer tells which.
  useEffect(() => {
    let perm: PermissionStatus | null = null;
    navigator.permissions
      ?.query({ name: "geolocation" })
      .then((p) => {
        perm = p;
        p.onchange = () => setGpsNonce((n) => n + 1);
      })
      .catch(() => {});
    return () => {
      if (perm) perm.onchange = null;
    };
  }, []);

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
          try {
            serverRows.current.set(r.id, await api.myRecordingGps(r.id));
          } catch {
            /* retry next tick */
          }
        }
      }
      const verifiedIds = new Set(verified.map((r) => r.id));
      const localRows = await Promise.all(local.filter((r) => !verifiedIds.has(r.id)).map((r) => gpsOf(r.id).catch(() => [])));
      // one track per recording, kept apart: coverage never joins the end of one to the start of the next
      const tracks = [...verified.map((r) => serverRows.current.get(r.id) ?? []), ...localRows];
      const m = cur.segments.map((x) => coverageMask(x.coords, tracks, CONFIG.coverage));
      if (dead) return;
      setMasks(m);
      setLocalCov(m.map((x) => (x.samples.length ? x.covered.filter(Boolean).length / x.samples.length : 0)));
    };
    void calc();
    const t = setInterval(calc, 1500);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [run?.id, local.length]);

  // Home needs no camera. It closes on the way back, and when a recording has ended.
  useEffect(() => {
    if (step !== "home" || session.active) return;
    wantCamera.current = false;
    setOnboarding(false);
    closeCamera();
  }, [step, !!session.active]);
  useEffect(
    () => () => {
      wantCamera.current = false;
      if (!getSession().active) closeCamera();
    },
    [],
  );

  // The sub-pages cannot be opened directly.
  const home = `#/assignment/${id}`;
  useEffect(() => {
    if (session.active) return;
    if (step === "record" || (step === "onboard" && !onboarding)) location.replace(home);
  }, [step, onboarding, !!session.active, home]);

  // Never replaces a running recording: it keeps going whatever the server says about the assignment.
  if (gone && !(session.active && session.activeAssignmentId === id)) {
    return (
      <section className="card">
        <h3>Assignment not found</h3>
        <p className="muted">It may have been withdrawn or removed. Recordings still on this phone are kept.</p>
        <a className="btn" href="#/">
          Back to my assignments
        </a>
      </section>
    );
  }
  if (!run) return <p>{offline ? "Can't reach the server. Trying again…" : "Loading…"}</p>;

  const pre = run.preflight ?? preflightLocal;
  const preflightDone = !!pre && !redo;
  const cov = (i: number) => Math.max(run.segments[i].coverage, localCov[i] ?? 0);
  const completed = run.status === "completed";
  const interrupted = local.some((r) => r.status === "interrupted");

  if (session.active && session.activeAssignmentId === id) {
    return (
      <RecordingView
        run={run}
        cov={run.segments.map((_, i) => cov(i))}
        masks={masks}
        fix={fix}
        trail={trail}
        camera={session.camera}
        active={session.active}
        onSkip={async (segId) => {
          try {
            setRun(await api.mySkip(id, segId, "skipped while recording"));
          } catch {
            /* shown on the next refresh */
          }
        }}
      />
    );
  }

  // What stops a recording from starting. Empty means it may start; nothing else starts one.
  const blockedAtHome = completed
    ? "This assignment is completed"
    : interrupted
      ? "Finalize the cut-off recording first"
      : session.active
        ? "Another recording is running"
        : "";
  const whyNot = gpsDenied
    ? "Location is blocked"
    : !preflightDone
      ? "Waiting for the GPS check"
      : !session.camera
        ? "Waiting for the camera"
        : !storage
          ? "Checking storage…"
          : !storage.ok
            ? "Not enough free storage"
            : blockedAtHome;

  const beginOnboarding = () => {
    wantCamera.current = true;
    setOnboarding(true);
    if (!gpsDenied) void cameraOpener.open(); // inside the tap, so the permission prompt is allowed
    location.hash = `${home}/onboard`;
  };
  const startNow = async () => {
    if (whyNot) return;
    try {
      setSession({ lastStop: null });
      const ar = await startRecording({
        assignmentId: id,
        simulated: getSettings().fake || !!session.camera!.fake,
        stream: session.camera!.stream,
        gps: gpsSource(),
        onChange: () => {},
        onStopped: (reason) => {
          setSession({ active: null, activeAssignmentId: null, lastStop: reason });
          fakeGps.stopWalking();
        },
      });
      setSession({ active: ar, activeAssignmentId: id });
      location.hash = `${home}/record`;
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  if (step === "onboard" && onboarding) {
    return (
      <>
        <Onboard
          run={run}
          pre={pre}
          preflightDone={preflightDone}
          gpsDenied={gpsDenied}
          storage={storage}
          recheck={recheck}
          camera={cameraOpener}
          why={whyNot}
          onPreflight={(o) => {
            setPreflightLocal(o);
            setRedo(false);
            void load();
          }}
          onRedo={() => setRedo(true)}
          onStart={() => void startNow()}
        />
        {devToolsOn() && <DevPanel />}
      </>
    );
  }

  let nearest = Infinity;
  let nearestIdx = -1;
  if (fix) {
    run.segments.forEach((sg, i) => {
      const d = distToLineM([fix.lng, fix.lat], sg.coords);
      if (d < nearest) {
        nearest = d;
        nearestIdx = i;
      }
    });
  }
  const requiredTotal = run.segments.filter((x) => x.required).length;
  const requiredDone = run.segments.filter((x, i) => x.required && (x.status === "completed" || cov(i) >= x.minCoverageRatio)).length;

  const nothingRecorded = run.recordings.length === 0 && local.length === 0;
  const notUploaded = local.filter(
    (r) => r.status !== "server_verified" && !run.recordings.some((x) => x.id === r.id && x.status === "server_verified"),
  );

  // What stops the worker from asking for the check. The server still decides the result.
  const whyNotFinish = nothingRecorded
    ? "Record at least once first"
    : interrupted
      ? "Finalize the cut-off recording first"
      : notUploaded.length
        ? "Waiting for your recordings to upload"
        : requiredDone < requiredTotal
          ? "Cover all required segments first"
          : offline
            ? "Needs a connection"
            : run.status === "needs_review"
              ? "An administrator will review this"
              : "";

  const act = async (fn: () => Promise<AssignmentDetail>) => {
    try {
      const d = await fn();
      setRun(d);
      return d;
    } catch (e: any) {
      toast.error(e.message);
    }
  };
  const finish = async () => {
    const d = await act(() => api.myFinish(id));
    if (d?.status === "completed") toast.success("Assignment completed");
    else if (d?.status === "needs_review") toast.info("Sent for review");
    else if (d) toast.warning("Not finished yet. See the reasons above the button.");
  };

  return (
    <>
      <section className="card">
        <div className="row between">
          <h3>{run.route.name}</h3>
          <Badge s={run.status} />
        </div>
        <p className="small muted">
          {requiredDone}/{requiredTotal} required segments covered
          {offline && <span className="err"> · server unreachable, showing the saved copy</span>}
        </p>
      </section>

      <Recovery assignmentId={id} />

      <div className="map">
        <MapContainer ref={setHomeMap} center={[13.7563, 100.5018]} zoom={16} style={{ height: "100%" }}>
          <Tiles />
          <FitOnce run={run} />
          {run.segments.map((sg, i) => {
            const color =
              sg.status === "skipped" ? "#9ca3af" : cov(i) >= sg.minCoverageRatio ? "#16a34a" : sg.required ? "#1d4ed8" : "#ea580c";
            return (
              <Fragment key={sg.id}>
                <Polyline positions={sg.coords.map(ll)} pathOptions={{ color, weight: 6, dashArray: sg.required ? undefined : "8 8" }} />
                <DirectionArrows coords={sg.coords} color={color} />
              </Fragment>
            );
          })}
          {trail.length > 1 && <Polyline positions={trail.map(ll)} pathOptions={{ color: "#111827", weight: 2 }} />}
          {fix && <Circle center={[fix.lat, fix.lng]} radius={fix.acc} pathOptions={{ color: "#2563eb", weight: 1, fillOpacity: 0.1 }} />}
          {fix && (
            <AboveArrows>
              <CircleMarker
                center={[fix.lat, fix.lng]}
                radius={7}
                pathOptions={{ color: "#fff", fillColor: "#2563eb", fillOpacity: 1, weight: 2 }}
              />
            </AboveArrows>
          )}
        </MapContainer>
        <RecenterButtons map={homeMap} run={run} fix={fix} />
      </div>
      <p className="small muted">
        {gpsDenied ? <span className="err">Location is blocked</span> : fix ? `GPS ±${fix.acc.toFixed(0)} m` : "No GPS fix yet"}
        {fix && nearestIdx >= 0 && ` · ${nearest.toFixed(0)} m from segment #${nearestIdx + 1}`}
      </p>

      {session.lastStop && session.lastStop !== "stopped by worker" && (
        <p className="warn-box">Last recording stopped: {session.lastStop}. Start a new one to continue.</p>
      )}
      {!completed && (
        <button className="cta" disabled={!!blockedAtHome} onClick={beginOnboarding}>
          Start Recording
        </button>
      )}
      {!completed && blockedAtHome && <p className="muted small center">{blockedAtHome}</p>}

      <section className="card">
        <h3>Segments</h3>
        {run.segments.map((sg, i) => {
          const c = cov(i);
          const done = c >= sg.minCoverageRatio && sg.status !== "skipped";
          return (
            <div key={sg.id} className="seg">
              <div className="row between">
                <span>
                  #{i + 1} <Badge s={sg.required ? "required" : "optional"} /> <Badge s={done ? "completed" : sg.status} />
                </span>
                {!sg.required &&
                  !completed &&
                  !done &&
                  (sg.status === "skipped" ? (
                    <button className="ghost" onClick={() => void act(() => api.myUnskip(id, sg.id))}>
                      Undo skip
                    </button>
                  ) : (
                    <button className="ghost" onClick={() => void act(() => api.mySkip(id, sg.id, skipReason))}>
                      Skip
                    </button>
                  ))}
              </div>
              <div className="meter">
                <div style={{ width: `${c * 100}%` }} />
                <i style={{ left: `${sg.minCoverageRatio * 100}%` }} />
              </div>
              <div className="small muted">
                {(c * 100).toFixed(0)}% covered · need {(sg.minCoverageRatio * 100).toFixed(0)}%
                {sg.skipReason && ` · skipped: ${sg.skipReason}`}
              </div>
            </div>
          );
        })}
        {run.segments.some((x) => !x.required) && (
          <input placeholder="Reason for skipping (optional)" value={skipReason} onChange={(e) => setSkipReason(e.target.value)} />
        )}
      </section>

      <section className="card">
        <h3>Recordings</h3>
        <RecordingList assignmentId={id} server={run.recordings} />
        <div className="finish">
          {run.reasons.length > 0 && (
            <ul className="small">
              {run.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          {!completed && (
            <>
              <button className="cta" onClick={() => void finish()} disabled={!!whyNotFinish}>
                Check &amp; finish
              </button>
              {whyNotFinish && <p className="small muted center">{whyNotFinish}</p>}
            </>
          )}
        </div>
      </section>

      {devToolsOn() && <DevPanel />}
    </>
  );
}
