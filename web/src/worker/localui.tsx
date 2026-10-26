import { useEffect, useState } from "react";
import { Badge, fmtBytes } from "../ui.tsx";
import { type LocalRecording, allRecordings, localSummary, putRecording } from "./localdb.ts";
import { setSettings, useSettings, getRawSettings } from "./settings.ts";
import { onUploaderChange, uploadTick, uploaderLog, uploaderPaused } from "./uploader.ts";

export type LocalRow = LocalRecording & { chunks: number; bytes: number; gps: number; chunksPending: number; gpsPending: number };

/** Polls IndexedDB so the screen always shows what is really stored on this phone. */
export function useLocalRecordings(assignmentId?: string): LocalRow[] {
  const [rows, setRows] = useState<LocalRow[]>([]);
  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const recs = (await allRecordings()).filter((r) => !assignmentId || r.assignmentId === assignmentId).sort((a, b) => a.startedAt - b.startedAt);
        const out = await Promise.all(recs.map(async (r) => ({ ...r, ...(await localSummary(r.id)) })));
        if (!dead) setRows(out);
      } catch { /* not signed in yet */ }
    };
    void load();
    const t = setInterval(load, 1500);
    const off = onUploaderChange(load);
    return () => { dead = true; clearInterval(t); off(); };
  }, [assignmentId]);
  return rows;
}

export function LocalRecordings({ assignmentId }: { assignmentId?: string }) {
  // a verified recording has had its chunks and GPS deleted from this phone on purpose; it is listed under "Saved on the server"
  const rows = useLocalRecordings(assignmentId).filter((r) => r.status !== "server_verified");
  const [, force] = useState(0);
  useEffect(() => onUploaderChange(() => force((n) => n + 1)), []);
  return (
    <section className="card">
      <h3>On this phone</h3>
      {uploaderPaused() && <p className="warn-box">Uploads are paused because you were signed out. Sign in again; nothing is lost.</p>}
      {rows.length === 0 ? <p className="muted">Nothing is waiting on this phone.</p> : rows.map((r) => (
        <div key={r.id} className="local-rec">
          <div className="row between wrap">
            <span><code>{r.id.slice(0, 8)}</code>{r.simulated && <> <Badge s="simulated" /></>}</span>
            <Badge s={r.status} />
          </div>
          <div className="small muted local-stats">
            <span>{r.chunks} chunks</span>
            <span>unsent {r.chunksPending}c / {r.gpsPending}g</span>
            <span>{fmtBytes(r.bytes)}</span>
            <span>{r.gps} gps</span>
          </div>
          {r.lastError && <div className="err small">{r.lastError}</div>}
        </div>
      ))}
      <div className="row">
        <button className="ghost" disabled={rows.length === 0 || uploaderPaused()} onClick={() => void uploadTick()}
          title={rows.length === 0 ? "Nothing to upload" : uploaderPaused() ? "Sign in again to upload" : undefined}>Upload now</button>
      </div>
      {rows.length > 0 && uploaderLog().length > 0 && <pre className="log">{uploaderLog().slice(0, 6).join("\n")}</pre>}
    </section>
  );
}

/** Cut-off recordings (refresh, crash, closed tab) must be dealt with before new work starts. */
export function Recovery({ assignmentId }: { assignmentId?: string }) {
  const rows = useLocalRecordings(assignmentId).filter((r) => r.status === "interrupted");
  if (rows.length === 0) return null;
  return (
    <section className="card warn">
      <h3>Recovery needed</h3>
      <p>These recordings were cut off (refresh, crash, closed tab). What was saved is kept. They cannot continue: finalize them so they upload, then start a new recording.</p>
      {rows.map((r) => (
        <div key={r.id} className="row between">
          <span>{r.id.slice(0, 8)} · {r.chunks} chunks · {fmtBytes(r.bytes)} · {r.gps} gps</span>
          <button onClick={() => void putRecording({ ...r, status: "pending_upload" }).then(() => uploadTick())}>Finalize &amp; upload</button>
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
      <label className="check"><input type="checkbox" checked={s.fake} onChange={(e) => setSettings({ fake: e.target.checked })} /> Fake mode (simulated GPS + canvas camera)</label>
      <label className="check"><input type="checkbox" checked={s.simOffline} onChange={(e) => setSettings({ simOffline: e.target.checked })} /> Simulate offline (uploads fail)</label>
      <div className="grid2">
        <label>Fake speed (m/s)<input type="number" min={1} max={40} value={s.fakeSpeed} onChange={(e) => setSettings({ fakeSpeed: +e.target.value })} /></label>
        <label>Fake GPS warm-up (s, 999 = never)<input type="number" min={0} value={s.coldStartS} onChange={(e) => setSettings({ coldStartS: +e.target.value })} /></label>
        <label>Preflight timeout (s)<input type="number" min={5} value={s.preflightTimeoutS} onChange={(e) => setSettings({ preflightTimeoutS: +e.target.value })} /></label>
      </div>
    </section>
  );
}
