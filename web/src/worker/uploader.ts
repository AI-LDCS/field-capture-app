import { CONFIG } from "@shared/config.ts";
import {
  type LocalRecording, allRecordings, chunksOf, deleteRecording, getRecording, gpsOf,
  markUploaded, openDb, purgeRecordingData, putRecording,
} from "./localdb.ts";
import { getSettings } from "./settings.ts";

const ENDED = new Set(["pending_upload", "uploading", "upload_interrupted"]);
let busy = false;
let paused = false; // the session ended: keep everything on the phone and wait for a new login
const log: string[] = [];
const listeners = new Set<() => void>();
export const uploaderLog = () => log;
export const uploaderPaused = () => paused;
export const onUploaderChange = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));
const note = (m: string) => {
  log.unshift(`${new Date().toLocaleTimeString()} ${m}`);
  log.length = Math.min(log.length, 40);
  listeners.forEach((f) => f());
};

class AuthLost extends Error {}

async function http(path: string, init?: RequestInit) {
  if (getSettings().simOffline) throw new Error("offline (simulated)");
  const r = await fetch(path, { ...init, credentials: "same-origin" });
  if (r.status === 401) throw new AuthLost("signed out");
  const body = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, body };
}
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const API = "/api/me/recordings";

async function setStatus(rec: LocalRecording, status: LocalRecording["status"], lastError?: string) {
  const fresh = (await getRecording(rec.id)) ?? rec;
  const next = { ...fresh, status, lastError };
  await putRecording(next);
  return next;
}

async function processOne(r0: LocalRecording) {
  let rec = r0;
  const ended = ENDED.has(rec.status);

  // 1. register on the server (idempotent)
  if (!rec.serverRegistered) {
    const res = await http(API, json({ id: rec.id, assignmentId: rec.assignmentId, mime: rec.mime, startedAt: rec.startedAt, simulated: rec.simulated }));
    if (!res.ok) throw new Error(`register: ${res.body.message ?? res.status}`);
    rec = { ...((await getRecording(rec.id)) ?? rec), serverRegistered: true };
    await putRecording(rec);
  }

  // 2. nothing to send? drop the empty recording
  if (ended) {
    const [c] = await chunksOf(rec.id);
    if (!c) {
      await http(`${API}/${rec.id}`, { method: "DELETE" });
      await deleteRecording(rec.id);
      note(`dropped empty recording ${rec.id.slice(0, 8)}`);
      return;
    }
    if (rec.status === "pending_upload") rec = await setStatus(rec, "uploading");
  }

  // 3. ask the server what it already has (resume without re-sending)
  const st = await http(`${API}/${rec.id}/status`);
  if (!st.ok) throw new Error(`status: ${st.body.message ?? st.status}`);
  if (st.body.verified) {
    await setStatus(rec, "server_verified");
    await purgeRecordingData(rec.id);
    return;
  }
  await markUploaded("chunks", rec.id, st.body.chunkSeqs);
  await markUploaded("gps", rec.id, st.body.gpsSeqs);

  // 4. chunks
  for (const c of await chunksOf(rec.id)) {
    if (c.uploaded) continue;
    const res = await http(`${API}/${rec.id}/chunks/${c.seq}`, {
      method: "PUT",
      headers: { "x-sha256": c.sha256, "content-type": "application/octet-stream" },
      body: c.blob,
    });
    if (!res.ok) throw new Error(`chunk ${c.seq}: ${res.body.message ?? res.status}`);
    await markUploaded("chunks", rec.id, [c.seq]);
  }

  // 5. gps in batches
  const pending = (await gpsOf(rec.id)).filter((g) => !g.uploaded);
  for (let i = 0; i < pending.length; i += CONFIG.upload.gpsBatchSize) {
    const batch = pending.slice(i, i + CONFIG.upload.gpsBatchSize);
    const res = await http(`${API}/${rec.id}/gps`, json({ points: batch.map(({ seq, t, lat, lng, acc }) => ({ seq, t, lat, lng, acc })) }));
    if (!res.ok) throw new Error(`gps: ${res.body.message ?? res.status}`);
    await markUploaded("gps", rec.id, batch.map((g) => g.seq));
  }

  // 6. finalize only when the recording is over and everything is confirmed
  const cur = (await getRecording(rec.id)) ?? rec;
  if (!ENDED.has(cur.status)) return;
  const chunks = await chunksOf(rec.id);
  const gps = await gpsOf(rec.id);
  if (chunks.some((c) => !c.uploaded) || gps.some((g) => !g.uploaded)) return;
  const res = await http(`${API}/${rec.id}/finalize`, json({
    startedAt: cur.startedAt,
    endedAt: cur.endedAt,
    stopReason: cur.stopReason ?? null,
    chunks: chunks.map((c) => ({ seq: c.seq, sha256: c.sha256 })),
    gpsCount: gps.length,
  }));
  if (res.ok) {
    await setStatus(cur, "server_verified");
    await purgeRecordingData(rec.id); // local copy goes only after the server verified it
    note(`verified ${rec.id.slice(0, 8)} (${chunks.length} chunks, ${gps.length} gps)`);
    return;
  }
  // the server disagrees with our "uploaded" flags: forget them and resend what it lacks
  if (res.status === 409 && res.body.error === "manifest_mismatch") {
    const b = res.body;
    await resetFlags(rec.id, [...(b.missingChunks ?? []), ...(b.mismatched ?? [])], b.gpsOk === false);
    throw new Error("server manifest mismatch; resending");
  }
  throw new Error(`finalize: ${res.body.message ?? res.status}`);
}

async function resetFlags(id: string, chunkSeqs: number[], resetGps: boolean) {
  const db = await openDb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(["chunks", "gps"], "readwrite");
    for (const seq of chunkSeqs) {
      const g = tx.objectStore("chunks").get([id, seq]);
      g.onsuccess = () => g.result && tx.objectStore("chunks").put({ ...g.result, uploaded: false });
    }
    if (resetGps) {
      const cur = tx.objectStore("gps").index("recordingId").openCursor(id);
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { c.update({ ...c.value, uploaded: false }); c.continue(); }
      };
    }
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function uploadTick() {
  if (busy || paused) return;
  busy = true;
  try {
    for (const rec of await allRecordings()) {
      if (rec.status === "server_verified" || rec.status === "interrupted") continue;
      try {
        await processOne(rec);
      } catch (e) {
        if (e instanceof AuthLost) { paused = true; note("signed out: uploads paused, nothing is lost"); return; }
        const msg = e instanceof Error ? e.message : String(e);
        const fresh = (await getRecording(rec.id)) ?? rec;
        if (ENDED.has(fresh.status)) await setStatus(fresh, "upload_interrupted", msg);
        else await putRecording({ ...fresh, lastError: msg });
        note(`${rec.id.slice(0, 8)}: ${msg}`);
      }
    }
  } finally {
    busy = false;
    listeners.forEach((f) => f());
  }
}

let timer: number | null = null;
let onlineHandler: (() => void) | null = null;

/** One uploader per signed-in user. It only reads that user's own local database. */
export function startUploader() {
  if (timer !== null) return;
  paused = false;
  timer = window.setInterval(() => void uploadTick(), CONFIG.upload.retryIntervalMs);
  onlineHandler = () => void uploadTick();
  window.addEventListener("online", onlineHandler);
  void uploadTick();
}
export function stopUploader() {
  if (timer !== null) clearInterval(timer);
  timer = null;
  if (onlineHandler) window.removeEventListener("online", onlineHandler);
  onlineHandler = null;
}
/** After the user signs in again following a lost session. */
export function resumeUploader() {
  paused = false;
  listeners.forEach((f) => f());
  void uploadTick();
}
