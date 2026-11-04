import { useEffect, useState } from "react";
import type { RecordingSummary } from "@shared/types.ts";
import { Badge, fmtBytes, when } from "../ui.tsx";
import { type LocalRecording, allRecordings, localSummary, putRecording } from "./localdb.ts";
import { devToolsOn, setSettings, useSettings, getRawSettings } from "./settings.ts";
import { onUploaderChange, uploadTick, uploaderLog, uploaderPaused } from "./uploader.ts";

export type LocalRow = LocalRecording & { chunks: number; bytes: number; gps: number; chunksPending: number; gpsPending: number };

/** Polls IndexedDB so the screen always shows what is really stored on this phone. */
export function useLocalRecordings(assignmentId?: string): LocalRow[] {
  const [rows, setRows] = useState<LocalRow[]>([]);
  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const recs = (await allRecordings())
          .filter((r) => !assignmentId || r.assignmentId === assignmentId)
          .sort((a, b) => a.startedAt - b.startedAt);
        const out = await Promise.all(recs.map(async (r) => ({ ...r, ...(await localSummary(r.id)) })));
        if (!dead) setRows(out);
      } catch {
        /* not signed in yet */
      }
    };
    void load();
    const t = setInterval(load, 1500);
    const off = onUploaderChange(load);
    return () => {
      dead = true;
      clearInterval(t);
      off();
    };
  }, [assignmentId]);
  return rows;
}

const WAITING = ["pending_upload", "pending_sync", "upload_interrupted"];

/**
 * One list for all recordings of an assignment, wherever each one is right now. The phone's copy
 * tells the upload progress until the server has verified it; after that the server's row offers the files.
 */
export function RecordingList({ assignmentId, server }: { assignmentId: string; server: RecordingSummary[] }) {
  const local = useLocalRecordings(assignmentId);
  const [, force] = useState(0);
  useEffect(() => onUploaderChange(() => force((n) => n + 1)), []);
  const verified = new Set(server.filter((r) => r.status === "server_verified").map((r) => r.id));
  const localIds = new Set(local.map((r) => r.id));
  const onPhone = local.filter((r) => r.status !== "server_verified" && r.status !== "interrupted" && !verified.has(r.id)); // Recovery lists the interrupted ones
  const fromServer = server.filter((r) => verified.has(r.id) || !localIds.has(r.id));
  const rows = [
    ...onPhone.map((r) => ({ at: r.startedAt, simulated: r.simulated, key: r.id, phone: r, saved: null })),
    ...fromServer.map((r) => ({ at: r.startedAtMs, simulated: r.simulated, key: r.id, phone: null, saved: r })),
  ].sort((a, b) => b.at - a.at);

  return (
    <>
      {uploaderPaused() && <p className="warn-box">Uploads are paused because you were signed out. Sign in again; nothing is lost.</p>}
      {rows.length === 0 && <p className="muted">No recordings yet.</p>}
      {rows.map(({ key, at, simulated, phone, saved }) => (
        <div key={key} className="local-rec">
          <div className="row between wrap">
            <span className="small">
              {when(new Date(at).toISOString())}
              {simulated && (
                <>
                  {" "}
                  <Badge s="simulated" />
                </>
              )}
            </span>
            {saved?.status === "server_verified" ? (
              <span className="ok small">✓ Saved</span>
            ) : phone && WAITING.includes(phone.status) ? (
              <span className="small muted">Waiting to upload</span>
            ) : phone?.status === "recording" ? (
              <span className="small muted">Recording</span>
            ) : (
              <span className="small muted">
                Uploading{phone && phone.chunks > 0 && ` ${Math.round(((phone.chunks - phone.chunksPending) / phone.chunks) * 100)}%`}
              </span>
            )}
          </div>
          {phone?.lastError && <div className="err small">{phone.lastError}</div>}
          {saved?.status === "server_verified" && (
            <div className="row wrap">
              {saved.assembly === "done" ? (
                <a className="btn ghost small" href={`/api/me/recordings/${saved.id}/download`}>
                  Video{saved.fileBytes !== null && ` (${fmtBytes(saved.fileBytes)})`}
                </a>
              ) : (
                <span className="small muted">{saved.assembly === "failed" ? "Video could not be prepared" : "Preparing video…"}</span>
              )}
              <a className="btn ghost small" href={`/api/me/recordings/${saved.id}/gps.json`}>
                GPS (.json)
              </a>
            </div>
          )}
        </div>
      ))}
      {onPhone.length > 0 && (
        <div className="row between wrap">
          <span className="small muted">Keep this browser until uploads finish.</span>
          <button className="ghost small" disabled={uploaderPaused()} onClick={() => void uploadTick()}>
            Upload now
          </button>
        </div>
      )}
      {devToolsOn() && onPhone.length > 0 && uploaderLog().length > 0 && <pre className="log">{uploaderLog().slice(0, 6).join("\n")}</pre>}
    </>
  );
}

/** Cut-off recordings (refresh, crash, closed tab) must be dealt with before new work starts. */
export function Recovery({ assignmentId }: { assignmentId?: string }) {
  const rows = useLocalRecordings(assignmentId).filter((r) => r.status === "interrupted");
  if (rows.length === 0) return null;
  return (
    <section className="card warn">
      <h3>Recovery needed</h3>
      <p>A recording was cut off. What was saved is kept. Finalize it to upload, then you can record again.</p>
      {rows.map((r) => (
        <div key={r.id} className="row between">
          <span>
            {r.id.slice(0, 8)} · {r.chunks} chunks · {fmtBytes(r.bytes)} · {r.gps} gps
          </span>
          <button onClick={() => void putRecording({ ...r, status: "pending_upload" }).then(() => uploadTick())}>
            Finalize &amp; upload
          </button>
        </div>
      ))}
    </section>
  );
}

/** Fake GPS and a canvas camera, to test without walking. Only shown when the server has dev tools on. */
export function DevPanel() {
  useSettings();
  const s = getRawSettings();
  return (
    <section className="card">
      <h3>Dev tools</h3>
      <p className="muted small">Recordings made with fake mode are marked simulated and always go to review.</p>
      <label className="check">
        <input type="checkbox" checked={s.fake} onChange={(e) => setSettings({ fake: e.target.checked })} /> Fake mode (simulated GPS +
        canvas camera)
      </label>
      <label className="check">
        <input type="checkbox" checked={s.simOffline} onChange={(e) => setSettings({ simOffline: e.target.checked })} /> Simulate offline
        (uploads fail)
      </label>
      <div className="grid2">
        <label>
          Fake speed (m/s)
          <input type="number" min={1} max={40} value={s.fakeSpeed} onChange={(e) => setSettings({ fakeSpeed: +e.target.value })} />
        </label>
        <label>
          Fake GPS warm-up (s, 999 = never)
          <input type="number" min={0} value={s.coldStartS} onChange={(e) => setSettings({ coldStartS: +e.target.value })} />
        </label>
        <label>
          Preflight timeout (s)
          <input type="number" min={5} value={s.preflightTimeoutS} onChange={(e) => setSettings({ preflightTimeoutS: +e.target.value })} />
        </label>
      </div>
    </section>
  );
}
