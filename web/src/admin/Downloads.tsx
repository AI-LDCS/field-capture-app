import { useState } from "react";
import type { DownloadRow } from "@shared/types.ts";
import { api } from "../api.ts";
import { Badge, Card, fmtBytes, useLoad, when } from "../ui.tsx";

const duration = (r: DownloadRow) => {
  if (r.endedAtMs === null) return "";
  const s = Math.max(0, Math.round((r.endedAtMs - r.startedAtMs) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Every verified recording as one list, each with its downloads. */
export function Downloads() {
  const { data, err } = useLoad(() => api.downloads());
  const [worker, setWorker] = useState("");

  const workers = new Map<string, string>();
  for (const r of data ?? []) workers.set(r.worker.id, r.worker.username + (r.worker.deleted ? " (deleted)" : ""));
  const rows = (data ?? []).filter((r) => !worker || r.worker.id === worker);

  return (
    <Card title="Downloads">
      <p className="muted small">Every verified recording, newest first. Each download is written to the audit log.</p>
      {err && <p className="err">{err}</p>}
      <div className="row wrap">
        <label>
          Worker
          <select value={worker} onChange={(e) => setWorker(e.target.value)}>
            <option value="">All workers</option>
            {[...workers]
              .sort((a, b) => a[1].localeCompare(b[1]))
              .map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
          </select>
        </label>
      </div>
      {data && rows.length === 0 && <p className="muted">No verified recordings yet.</p>}
      {rows.map((r) => (
        <div key={r.id} className="item row between">
          <div>
            <a href={`#/assignment/${r.assignmentId}`}>
              <strong>{r.route.name}</strong>
            </a>
            {r.route.deleted && <span className="muted"> (deleted)</span>} <span className="muted">v{r.route.version}</span>{" "}
            {r.simulated && <Badge s="simulated" />}
            <div className="small muted">
              {r.worker.username}
              {r.worker.deleted && " (deleted)"} · {when(new Date(r.startedAtMs).toISOString())}
              {duration(r) && <> · {duration(r)}</>}
              {r.fileBytes !== null && <> · {fmtBytes(r.fileBytes)}</>} · {r.gpsCount} gps
            </div>
          </div>
          <div className="row wrap">
            {r.assembly === "done" ? (
              <a className="btn ghost small" href={`/api/admin/recordings/${r.id}/download`}>
                Video
              </a>
            ) : (
              <span className="small muted">{r.assembly === "failed" ? "video build failed" : "preparing video…"}</span>
            )}
            <a className="btn ghost small" href={`/api/admin/recordings/${r.id}/gps.json`}>
              GPS (.json)
            </a>
            <a className="btn ghost small" href={`/api/admin/assignments/${r.assignmentId}/export.zip`}>
              All (.zip)
            </a>
          </div>
        </div>
      ))}
    </Card>
  );
}
