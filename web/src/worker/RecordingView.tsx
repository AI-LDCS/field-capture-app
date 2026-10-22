import { useEffect, useRef, useState, type ReactNode } from "react";
import { Circle, CircleMarker, MapContainer, Polyline, useMap, useMapEvents } from "react-leaflet";
import { CONFIG } from "@shared/config.ts";
import { bearingDeg, compass, distToLineM, haversineM } from "@shared/geo.ts";
import type { AssignmentDetail, LngLat } from "@shared/types.ts";
import type { CameraInfo } from "./camera.ts";
import { type Fix, fakeGps } from "./gps.ts";
import type { ActiveRecording } from "./recorder.ts";
import { useSettings } from "./settings.ts";
import { Tiles, fmtBytes } from "../ui.tsx";

export type Mask = { samples: LngLat[]; covered: boolean[] };

const ll = (c: LngLat): [number, number] => [c[1], c[0]];
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const SPLIT_KEY = "fc-split";

/** Where to go next: the closest not-yet-covered part of the first unfinished segment. */
function nextTarget(run: AssignmentDetail, masks: Mask[], cov: number[], fix: Fix | null) {
  const idx = run.segments.findIndex((s, i) => s.status !== "skipped" && cov[i] < s.minCoverageRatio);
  if (idx < 0) return null;
  const m = masks[idx];
  const open = m ? m.samples.filter((_, k) => !m.covered[k]) : [];
  const pool = open.length ? open : run.segments[idx].coords;
  let best = pool[0];
  if (fix) {
    let bd = Infinity;
    for (const p of pool) {
      const d = haversineM([fix.lng, fix.lat], p);
      if (d < bd) { bd = d; best = p; }
    }
  }
  const from: LngLat | null = fix ? [fix.lng, fix.lat] : null;
  return {
    idx, point: best, required: run.segments[idx].required,
    dist: from ? haversineM(from, best) : null,
    bearing: from ? bearingDeg(from, best) : null,
    // share of the segment still open, times its real length (the stored curve has a point every ~2 m, not every stepM)
    leftM: m && m.samples.length ? run.segments[idx].lengthM * (open.length / m.samples.length) : run.segments[idx].lengthM,
  };
}

function AutoResize() {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [map]);
  return null;
}

function Camera({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream; }, [stream]);
  return <video ref={ref} className="rv-video" autoPlay muted playsInline />;
}

function MapPane(props: {
  run: AssignmentDetail; cov: number[]; fix: Fix | null; trail: LngLat[];
  target: ReturnType<typeof nextTarget>; follow: boolean; setFollow: (b: boolean) => void;
}) {
  const { run, cov, fix, trail, target, follow, setFollow } = props;
  return (
    <MapContainer center={[13.7563, 100.5018]} zoom={18} style={{ height: "100%" }}>
      <Tiles />
      <AutoResize />
      <MapBehaviour fix={fix} follow={follow} setFollow={setFollow} run={run} />
      {run.segments.map((sg, i) => (
        <Polyline key={sg.id} positions={sg.coords.map(ll)}
          pathOptions={{
            color: sg.status === "skipped" ? "#9ca3af" : cov[i] >= sg.minCoverageRatio ? "#16a34a" : sg.required ? "#1d4ed8" : "#ea580c",
            weight: 7, opacity: 0.8, dashArray: sg.required ? undefined : "8 8",
          }} />
      ))}
      {trail.length > 1 && <Polyline positions={trail.map(ll)} pathOptions={{ color: "#111827", weight: 3 }} />}
      {fix && target && <Polyline positions={[[fix.lat, fix.lng], ll(target.point)]} pathOptions={{ color: "#dc2626", weight: 3, dashArray: "4 8" }} />}
      {target && <CircleMarker center={ll(target.point)} radius={9} pathOptions={{ color: "#dc2626", weight: 3, fillColor: "#fff", fillOpacity: 1 }} />}
      {fix && <Circle center={[fix.lat, fix.lng]} radius={fix.acc} pathOptions={{ color: "#2563eb", weight: 1, fillOpacity: 0.1 }} />}
      {fix && <CircleMarker center={[fix.lat, fix.lng]} radius={8} pathOptions={{ color: "#fff", weight: 3, fillColor: "#2563eb", fillOpacity: 1 }} />}
    </MapContainer>
  );
}

/** Fit the route once, then follow the worker until they drag the map. */
function MapBehaviour({ fix, follow, setFollow, run }: { fix: Fix | null; follow: boolean; setFollow: (b: boolean) => void; run: AssignmentDetail }) {
  const map = useMap();
  const fitted = useRef(false);
  useMapEvents({ dragstart: () => setFollow(false) });
  useEffect(() => {
    if (fitted.current) return;
    const pts = run.segments.flatMap((s) => s.coords.map(ll));
    if (pts.length) { map.fitBounds(pts, { padding: [30, 30] }); fitted.current = true; }
  }, [map, run]);
  useEffect(() => {
    if (follow && fix) map.panTo([fix.lat, fix.lng], { animate: true, duration: 0.5 });
  }, [map, follow, fix?.lat, fix?.lng]);
  return null;
}

export default function RecordingView(props: {
  run: AssignmentDetail; cov: number[]; masks: Mask[]; fix: Fix | null; trail: LngLat[];
  camera: CameraInfo | null; active: ActiveRecording; onSkip: (segmentId: string) => Promise<void>;
}) {
  const { run, cov, masks, fix, trail, camera, active, onSkip } = props;
  const s = useSettings();
  const [, tick] = useState(0);
  const [split, setSplit] = useState(() => {
    try { return Math.min(0.85, Math.max(0.15, Number(localStorage.getItem(SPLIT_KEY)) || 0.55)); } catch { return 0.55; }
  });
  const [swap, setSwap] = useState(false);
  const [follow, setFollow] = useState(true);
  const [confirmStop, setConfirmStop] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!confirmStop) return;
    const t = setTimeout(() => setConfirmStop(false), 3000);
    return () => clearTimeout(t);
  }, [confirmStop]);

  const move = (e: React.PointerEvent) => {
    if (!dragging.current || !area.current) return;
    const r = area.current.getBoundingClientRect();
    setSplit(Math.min(0.85, Math.max(0.15, (e.clientY - r.top) / r.height)));
  };
  const end = (e: React.PointerEvent) => {
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    try { localStorage.setItem(SPLIT_KEY, String(split)); } catch { /* ignore */ }
  };

  const st = active.stats();
  const target = nextTarget(run, masks, cov, fix);
  const offRoute = fix ? Math.min(...run.segments.map((sg) => distToLineM([fix.lng, fix.lat], sg.coords))) : null;
  const walkable = run.segments.filter((x) => x.status !== "skipped");

  const mapPane = (
    <MapPane run={run} cov={cov} fix={fix} trail={trail} target={target} follow={follow} setFollow={setFollow} />
  );
  const videoPane = camera ? <Camera stream={camera.stream} /> : <div className="rv-video" />;
  const first: ReactNode = swap ? videoPane : mapPane;
  const second: ReactNode = swap ? mapPane : videoPane;

  return (
    <div className="rv">
      <div className="rv-bar">
        <span className="rec">● {mmss(Date.now() - st.startedAt)}</span>
        <span className="small muted">{st.chunks} chunks · {fmtBytes(st.bytes)} · {st.gps} gps</span>
        <span className="grow" />
        <button className="ghost" onClick={() => setSwap(!swap)} title="Swap panes">⇅</button>
        <button className={confirmStop ? "danger" : "ghost danger-text"}
          onClick={() => (confirmStop ? void active.stop("stopped by worker") : setConfirmStop(true))}>
          {confirmStop ? "Tap again to stop" : "Stop"}
        </button>
      </div>
      {st.error && <div className="rv-hint err">{st.error}</div>}

      <div className="rv-hint">
        {!target ? (
          <strong>All segments covered. Stop recording when you are ready.</strong>
        ) : (
          <>
            <span className="arrow" style={{ transform: `rotate(${target.bearing ?? 0}deg)`, opacity: target.bearing === null ? 0.3 : 1 }}>↑</span>
            <span>
              <strong>{target.dist === null ? "Waiting for GPS…" : `${target.dist.toFixed(0)} m ${compass(target.bearing!)}`}</strong>{" "}
              to segment #{target.idx + 1}{!target.required && " (optional)"}
              <span className="muted small"> · {target.leftM.toFixed(0)} m left on it</span>
            </span>
            {!target.required && (
              <button className="ghost skip" onClick={() => void onSkip(run.segments[target.idx].id)}>Skip it</button>
            )}
          </>
        )}
        {offRoute !== null && offRoute > CONFIG.quality.offRouteM && <span className="err small"> · off route {offRoute.toFixed(0)} m</span>}
        {fix && fix.acc > CONFIG.coverage.maxAccuracyM && <span className="err small"> · GPS weak ±{fix.acc.toFixed(0)} m</span>}
      </div>

      <div className="rv-area" ref={area}>
        <div className="rv-pane" style={{ flexBasis: `${split * 100}%` }}>
          {first}
          {!swap && !follow && <button className="rv-locate" onClick={() => setFollow(true)}>⌖ Follow me</button>}
        </div>
        <div className="rv-handle" onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={move} onPointerUp={end} onPointerCancel={end}><i /></div>
        <div className="rv-pane grow">
          {second}
          {swap && !follow && <button className="rv-locate" onClick={() => setFollow(true)}>⌖ Follow me</button>}
        </div>
      </div>

      <div className="rv-segs">
        {run.segments.map((sg, i) => {
          const done = sg.status === "skipped" ? "skip" : cov[i] >= sg.minCoverageRatio ? "done" : "";
          return (
            <span key={sg.id} className={`chip ${done} ${target?.idx === i ? "now" : ""}`}>
              #{i + 1}{!sg.required && "·opt"} {sg.status === "skipped" ? "skipped" : `${(cov[i] * 100).toFixed(0)}%`}
            </span>
          );
        })}
        {s.fake && (
          <>
            <button className="ghost" onClick={() => fakeGps.walk(walkable.map((x) => x.coords))}>Fake: walk all</button>
            <button className="ghost" onClick={() => fakeGps.walk(walkable.filter((x) => x.required).map((x) => x.coords))}>Fake: required only</button>
            <button className="ghost" onClick={() => fakeGps.stopWalking()}>Fake: stop</button>
          </>
        )}
      </div>
    </div>
  );
}
