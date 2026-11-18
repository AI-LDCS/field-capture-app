import { Fragment, useEffect, useRef, useState } from "react";
import { Circle, CircleMarker, MapContainer, Polyline, useMap } from "react-leaflet";
import type { AssignmentDetail, LngLat, RecordingSummary } from "@shared/types.ts";
import { api } from "../api.ts";
import { confirmDialog, toast } from "../feedback.tsx";
import { Play } from "../icons.tsx";
import { AboveArrows, Badge, Card, DirectionArrows, FitTo, Tiles, fmtBytes, ll, useLoad, when } from "../ui.tsx";

type Row = { seq: number; t: number; lat: number; lng: number; acc: number };

/** Position at time t, interpolated between the two surrounding fixes. Null if no fix within 5 s. */
function positionAt(rows: Row[], t: number): { lat: number; lng: number; acc: number } | null {
  if (!rows.length || t < rows[0].t - 5000 || t > rows[rows.length - 1].t + 5000) return null;
  let lo = 0,
    hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  const b = rows[lo],
    a = rows[Math.max(0, lo - 1)];
  const f = b.t === a.t ? 1 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, acc: a.acc + (b.acc - a.acc) * f };
}

function Follow({ pos, on }: { pos: { lat: number; lng: number } | null; on: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (on && pos && !map.getBounds().pad(-0.2).contains([pos.lat, pos.lng])) map.panTo([pos.lat, pos.lng]);
  }, [map, on, pos?.lat, pos?.lng]);
  return null;
}

const segColor = (s: AssignmentDetail["segments"][number]) =>
  s.status === "completed" ? "#16a34a" : s.status === "skipped" ? "#9ca3af" : s.required ? "#1d4ed8" : "#ea580c";

const anonymizationText: Record<RecordingSummary["anonymization"], string> = {
  none: "",
  pending: "anonymizing…",
  running: "anonymizing…",
  done: "anonymized",
  failed: "anonymizing failed",
};

const framesText = (f: RecordingSummary["frames"]) =>
  f.state === "pending" || f.state === "running"
    ? "making images…"
    : f.state === "failed"
      ? `images failed${f.error ? `: ${f.error}` : ""}`
      : f.state === "done"
        ? `${f.count} images every ${f.stepM} m`
        : "";

const assemblyText: Record<RecordingSummary["assembly"], string> = {
  none: "not verified",
  pending: "preparing video…",
  running: "preparing video…",
  done: "ready",
  failed: "video build failed",
};

export default function Review({ id }: { id: string }) {
  const { data: run, err, reload } = useLoad(() => api.assignment(id), [id]);
  const audit = useLoad(() => api.assignmentAudit(id), [id]);
  const [tracks, setTracks] = useState<Record<string, Row[]>>({});
  const [play, setPlay] = useState<{ recId: string; tMs: number } | null>(null);
  const [follow, setFollow] = useState(true);
  const videos = useRef(new Map<string, HTMLVideoElement>());

  // keep polling while a video is still being built (fast), or its anonymized copy is (slow: it can take hours)
  const preparing = run?.recordings.some((r) => r.status === "server_verified" && r.assembly !== "done" && r.assembly !== "failed");
  const anonymizing = run?.recordings.some(
    (r) =>
      r.assembly === "done" &&
      (r.anonymization === "pending" || r.anonymization === "running" || r.frames.state === "pending" || r.frames.state === "running"),
  );
  useEffect(() => {
    if (!preparing && !anonymizing) return;
    const t = setInterval(reload, preparing ? 3000 : 20000);
    return () => clearInterval(t);
  }, [preparing, anonymizing]);

  useEffect(() => {
    if (!run) return;
    for (const r of run.recordings) {
      if (r.status !== "server_verified" || tracks[r.id]) continue;
      api
        .recordingGps(r.id)
        .then((rows) => setTracks((t) => ({ ...t, [r.id]: rows })))
        .catch(() => {});
    }
  }, [run?.recordings.map((r) => r.id + r.status).join()]);

  if (err)
    return (
      <>
        <p className="err">{err}</p>
        <a className="btn ghost" href="#/">
          Back
        </a>
      </>
    );
  if (!run) return <p>Loading…</p>;

  const act = async (fn: () => Promise<AssignmentDetail | unknown>, done: string) => {
    try {
      await fn();
      toast.success(done);
      reload();
      audit.reload();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const playing = play ? run.recordings.find((r) => r.id === play.recId) : undefined;
  const pos = play && tracks[play.recId] ? positionAt(tracks[play.recId], play.tMs) : null;
  const verified = run.recordings.filter((r) => r.status === "server_verified");
  const allPts: LngLat[] = [
    ...run.segments.flatMap((s) => s.coords),
    ...Object.values(tracks)
      .flat()
      .map((p) => [p.lng, p.lat] as LngLat),
  ];
  const q = run.quality;

  /** Jump the player to the moment a recording was on a segment. */
  const jump = (recId: string, tMs: number | null) => {
    const rec = run.recordings.find((r) => r.id === recId);
    const v = videos.current.get(recId);
    if (!rec || !v || tMs === null) return;
    v.scrollIntoView({ block: "center", behavior: "smooth" });
    v.currentTime = Math.max(0, (tMs - rec.startedAtMs) / 1000);
    void v.play().catch(() => {});
  };
  const timeOf = (r: RecordingSummary, e: HTMLVideoElement) => ({ recId: r.id, tMs: r.startedAtMs + e.currentTime * 1000 });

  return (
    <>
      <Card title={`${run.route.name}${run.route.deleted ? " (deleted)" : ""} · v${run.route.version}`} right={<Badge s={run.status} />}>
        <p className="small muted">
          Worker <strong>{run.worker.username}</strong>
          {run.worker.deleted && " (deleted)"} · assigned {when(run.createdAt)}
          {run.completedAt && <> · completed {when(run.completedAt)}</>}
        </p>
        {run.reasons.length > 0 && (
          <ul className="small">
            {run.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        <p className="small muted">
          GPS check:{" "}
          {run.preflight
            ? `${run.preflight.result} (${run.preflight.samples} samples, best ±${run.preflight.bestAccuracyM?.toFixed(0) ?? "?"} m)`
            : "not recorded"}
          {q && (
            <>
              {" "}
              · GPS: {q.total} points, {q.poorAccuracy} poor accuracy, {q.gaps} gaps, {q.jumps} jumps, {q.offRoute} off route
            </>
          )}
        </p>
        <div className="row wrap">
          <button onClick={() => void act(() => api.reEvaluate(id), "Re-evaluated")}>Re-evaluate</button>
          {run.status === "needs_review" && (
            <>
              <button onClick={() => void act(() => api.reviewAssignment(id, "approve"), "Approved")}>Approve</button>
              <button className="ghost" onClick={() => void act(() => api.reviewAssignment(id, "reject"), "Sent back to the worker")}>
                Send back
              </button>
            </>
          )}
          <a className="btn ghost" href="#/">
            Back
          </a>
        </div>
        {verified.length > 0 && (
          <div className="row wrap">
            <a className="btn" href={`/api/admin/assignments/${id}/export.zip`}>
              Download all (.zip)
            </a>
            <a className="btn ghost" href={`/api/admin/assignments/${id}/export.json`}>
              Data (.json)
            </a>
            <span className="small muted">{verified.length} verified recording(s): videos, GPS JSON, assignment.json</span>
          </div>
        )}
      </Card>

      <div className="map sticky">
        <MapContainer center={[13.7563, 100.5018]} zoom={16} style={{ height: "100%" }}>
          <Tiles />
          <FitTo pts={allPts.length ? allPts : null} />
          <Follow pos={pos} on={follow} />
          {run.segments.map((s) => (
            <Fragment key={s.id}>
              <Polyline
                positions={s.coords.map(ll)}
                pathOptions={{ color: segColor(s), weight: 7, opacity: 0.6, dashArray: s.required ? undefined : "8 8" }}
              />
              <DirectionArrows coords={s.coords} color={segColor(s)} />
            </Fragment>
          ))}
          {Object.entries(tracks).map(([rid, rows]) => (
            <Polyline
              key={rid}
              positions={rows.map((p) => [p.lat, p.lng] as [number, number])}
              pathOptions={{ color: rid === play?.recId ? "#dc2626" : "#111827", weight: rid === play?.recId ? 3 : 2 }}
            />
          ))}
          {pos && <Circle center={[pos.lat, pos.lng]} radius={pos.acc} pathOptions={{ color: "#dc2626", weight: 1, fillOpacity: 0.12 }} />}
          {pos && (
            <AboveArrows>
              <CircleMarker
                center={[pos.lat, pos.lng]}
                radius={9}
                pathOptions={{ color: "#fff", weight: 3, fillColor: "#dc2626", fillOpacity: 1 }}
              />
            </AboveArrows>
          )}
        </MapContainer>
      </div>
      <div className="row between small muted">
        <span>
          {!play
            ? "Play a recording to see where the camera was on the map."
            : pos
              ? `${playing?.id.slice(0, 8)} · ${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)} · ±${pos.acc.toFixed(0)} m`
              : "No GPS fix at this moment of the video."}
        </span>
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
        </label>
      </div>

      <Card title="Segments (decided by the server)">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>type</th>
                <th>status</th>
                <th>coverage</th>
                <th>seen in</th>
              </tr>
            </thead>
            <tbody>
              {run.segments.map((s, i) => (
                <tr key={s.id}>
                  <td>{i + 1}</td>
                  <td>{s.required ? "required" : "optional"}</td>
                  <td>
                    <Badge s={s.status} />
                    {s.skipReason && <div className="small muted">{s.skipReason}</div>}
                  </td>
                  <td>
                    {(s.coverage * 100).toFixed(0)}% / {(s.minCoverageRatio * 100).toFixed(0)}%
                  </td>
                  <td>
                    {s.evidence.length === 0 ? (
                      <span className="muted small">no GPS on it</span>
                    ) : (
                      s.evidence.map((e) => {
                        const ready = run.recordings.find((r) => r.id === e.recordingId)?.assembly === "done";
                        return (
                          <button
                            key={e.recordingId}
                            className="ghost small"
                            disabled={!ready}
                            title={ready ? "Jump to this part of the video" : "video not ready"}
                            onClick={() => jump(e.recordingId, e.firstTMs)}
                          >
                            <Play size={12} /> {e.recordingId.slice(0, 6)} {(e.coverage * 100).toFixed(0)}%
                          </button>
                        );
                      })
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">Coverage counts only server-verified recordings and uses the stored (smoothed) line.</p>
      </Card>

      <Card title="Recordings">
        {run.recordings.some((r) => r.assembly === "done") && (
          <div className="row wrap">
            <span className="small muted">
              Images for {run.purpose === "training" ? "training (the worker can download them)" : "scoring (admins only)"}
            </span>
            {run.recordings.some((r) => r.frames.state === "done") && (
              <a className="btn ghost small" href={`/api/admin/assignments/${id}/frames.zip`}>
                All images (.zip)
              </a>
            )}
            <button
              className="ghost small"
              onClick={async () => {
                const ok = await confirmDialog({
                  title: "Make the images again?",
                  body: "The images of every recording of this assignment are deleted and made again with the current step. Anything already downloaded will not match the new frame numbers.",
                  confirmLabel: "Make again",
                  danger: true,
                });
                if (ok) void act(() => api.rerunFrames(id), "Making the images again");
              }}
            >
              Make images again
            </button>
          </div>
        )}
        {run.recordings.length === 0 && <p className="muted">None.</p>}
        {run.recordings.map((r) => (
          <div key={r.id} className="item">
            <div className="row between">
              <span>
                {r.id.slice(0, 8)} <Badge s={r.status} /> {r.simulated && <Badge s="simulated" />}
              </span>
              <span className="small muted">
                {r.chunkCount} chunks · {fmtBytes(r.bytes)} · {r.gpsCount} gps{r.stopReason ? ` · stopped: ${r.stopReason}` : ""}
              </span>
            </div>
            {r.status === "server_verified" && (
              <>
                <div className="row wrap">
                  <span className="small muted">{assemblyText[r.assembly]}</span>
                  {r.assembly === "failed" && (
                    <button className="ghost small" onClick={() => void act(() => api.reassemble(r.id), "Building the video again")}>
                      Retry
                    </button>
                  )}
                  {r.assembly === "done" && (
                    <a className="btn ghost small" href={`/api/admin/recordings/${r.id}/download`}>
                      {r.anonymization === "none" ? "Video" : "Video (original)"}
                    </a>
                  )}
                  {r.assembly === "done" && <span className="small muted">{anonymizationText[r.anonymization]}</span>}
                  {r.anonymization === "failed" && (
                    <button className="ghost small" onClick={() => void act(() => api.reanonymize(r.id), "Anonymizing again")}>
                      Retry
                    </button>
                  )}
                  {r.anonymization === "done" && (
                    <a className="btn ghost small" href={`/api/admin/recordings/${r.id}/download?variant=anonymized`}>
                      Video (anonymized)
                    </a>
                  )}
                  <a className="btn ghost small" href={`/api/admin/recordings/${r.id}/gps.json`}>
                    GPS (.json)
                  </a>
                  {r.assembly === "done" && <span className="small muted">{framesText(r.frames)}</span>}
                  {r.frames.state === "done" && (
                    <a className="btn ghost small" href={`/api/admin/recordings/${r.id}/frames.zip`}>
                      Images (.zip)
                    </a>
                  )}
                </div>
                {r.assembly === "done" && (
                  <video
                    className="preview"
                    controls
                    playsInline
                    preload="metadata"
                    src={`/api/admin/recordings/${r.id}/video`}
                    ref={(el) => {
                      if (el) videos.current.set(r.id, el);
                      else videos.current.delete(r.id);
                    }}
                    onPlay={(e) => setPlay(timeOf(r, e.currentTarget))}
                    onTimeUpdate={(e) => setPlay(timeOf(r, e.currentTarget))}
                    onSeeked={(e) => setPlay(timeOf(r, e.currentTarget))}
                  />
                )}
              </>
            )}
          </div>
        ))}
      </Card>

      <Card title="Audit">
        <div className="table-scroll">
          <table>
            <tbody>
              {audit.data?.map((a) => (
                <tr key={a.id}>
                  <td className="small">{new Date(a.at).toLocaleString()}</td>
                  <td>{a.action}</td>
                  <td className="small muted">{a.actor ?? "system"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
