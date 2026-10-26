import type { AssignmentDetail, GpsPoint, RecordingStatus } from "@shared/types.ts";

export type LocalRecording = {
  id: string;
  assignmentId: string;
  mime: string;
  simulated: boolean;
  status: RecordingStatus;
  startedAt: number;
  endedAt: number | null;
  stopReason?: string;
  lastError?: string;
  serverRegistered: boolean;
};
export type LocalChunk = {
  recordingId: string;
  seq: number;
  blob: Blob;
  size: number;
  t: number; // commit time
  sha256: string;
  uploaded: boolean; // server-confirmed, separate from "locally committed"
};
export type LocalGps = GpsPoint & { recordingId: string; uploaded: boolean };
export type LocalAssignment = { id: string; detail: AssignmentDetail };

// One database per signed-in user: what is on this phone belongs to whoever recorded it, and the
// uploader of another user can never see, send or delete it.
let dbName = "";
let dbp: Promise<IDBDatabase> | null = null;
export function setLocalUser(userId: string | null) {
  dbName = userId ? `field-capture-${userId}` : "";
  resetDb();
}

/** Forget the open connection (closing it if it still works), so the next call opens a fresh one. */
export function resetDb() {
  void dbp?.then((d) => d.close()).catch(() => {});
  dbp = null;
}

export function openDb(): Promise<IDBDatabase> {
  if (!dbName) return Promise.reject(new Error("not signed in"));
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("recordings", { keyPath: "id" }).createIndex("assignmentId", "assignmentId");
      db.createObjectStore("chunks", { keyPath: ["recordingId", "seq"] }).createIndex("recordingId", "recordingId");
      db.createObjectStore("gps", { keyPath: ["recordingId", "seq"] }).createIndex("recordingId", "recordingId");
      db.createObjectStore("assignments", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const p = <T>(r: IDBRequest<T>) =>
  new Promise<T>((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

/** Resolves only after the transaction commits, which is what "locally committed" means. */
async function write(stores: string[], fn: (tx: IDBTransaction) => void): Promise<void> {
  const db = await openDb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(stores, "readwrite");
    fn(tx);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

async function readAll<T>(store: string, index?: string, key?: IDBValidKey): Promise<T[]> {
  const db = await openDb();
  const s = db.transaction(store).objectStore(store);
  return p((index ? s.index(index) : s).getAll(key) as IDBRequest<T[]>);
}

export const putRecording = (r: LocalRecording) => write(["recordings"], (tx) => void tx.objectStore("recordings").put(r));
export const putChunk = (c: LocalChunk) => write(["chunks"], (tx) => void tx.objectStore("chunks").put(c));
export const putGps = (g: LocalGps) => write(["gps"], (tx) => void tx.objectStore("gps").put(g));
export const putAssignment = (a: LocalAssignment) => write(["assignments"], (tx) => void tx.objectStore("assignments").put(a));

export async function getRecording(id: string) {
  return p((await openDb()).transaction("recordings").objectStore("recordings").get(id) as IDBRequest<LocalRecording | undefined>);
}
export const getAssignment = async (id: string) =>
  p((await openDb()).transaction("assignments").objectStore("assignments").get(id) as IDBRequest<LocalAssignment | undefined>);
export const allRecordings = () => readAll<LocalRecording>("recordings");
export const chunksOf = async (id: string) =>
  (await readAll<LocalChunk>("chunks", "recordingId", id)).sort((a, b) => a.seq - b.seq);
export const gpsOf = async (id: string) =>
  (await readAll<LocalGps>("gps", "recordingId", id)).sort((a, b) => a.seq - b.seq);

export async function markUploaded(kind: "chunks" | "gps", recordingId: string, seqs: number[]) {
  const db = await openDb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(kind, "readwrite");
    const store = tx.objectStore(kind);
    for (const seq of seqs) {
      const g = store.get([recordingId, seq]);
      g.onsuccess = () => g.result && store.put({ ...g.result, uploaded: true });
    }
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/** Retention: drop heavy local data only after the server verified the recording. */
export async function purgeRecordingData(recordingId: string) {
  const [chunks, gps] = await Promise.all([chunksOf(recordingId), gpsOf(recordingId)]);
  await write(["chunks", "gps"], (tx) => {
    for (const c of chunks) tx.objectStore("chunks").delete([recordingId, c.seq]);
    for (const g of gps) tx.objectStore("gps").delete([recordingId, g.seq]);
  });
}

export async function deleteRecording(id: string) {
  await purgeRecordingData(id);
  await write(["recordings"], (tx) => void tx.objectStore("recordings").delete(id));
}

/**
 * App start: anything still "recording" was cut off (refresh, crash, closed tab).
 * We cannot resume that MediaRecorder, so mark it interrupted; the worker finalizes it.
 */
export async function scanInterrupted(): Promise<LocalRecording[]> {
  const all = await allRecordings();
  const out: LocalRecording[] = [];
  // a recording that another tab of this browser is still writing is not cut off
  const held = new Set((await navigator.locks?.query?.().catch(() => undefined))?.held?.map((l) => l.name) ?? []);
  for (const r of all) {
    if (r.status === "recording" && held.has(`fc-rec-${r.id}`)) continue;
    if (r.status === "recording") {
      const chunks = await chunksOf(r.id);
      const gps = await gpsOf(r.id);
      const last = Math.max(r.startedAt, chunks.at(-1)?.t ?? 0, gps.at(-1)?.t ?? 0);
      const upd: LocalRecording = { ...r, status: "interrupted", endedAt: last, stopReason: "app closed or crashed" };
      await putRecording(upd);
      out.push(upd);
    } else if (r.status === "interrupted") out.push(r);
  }
  return out;
}

export async function localSummary(id: string) {
  const [chunks, gps] = await Promise.all([chunksOf(id), gpsOf(id)]);
  return {
    chunks: chunks.length,
    bytes: chunks.reduce((a, c) => a + c.size, 0),
    gps: gps.length,
    chunksPending: chunks.filter((c) => !c.uploaded).length,
    gpsPending: gps.filter((g) => !g.uploaded).length,
  };
}

/** Anything on this device that the server has not verified yet (shown before sign out). */
export async function unsentSummary() {
  const recs = (await allRecordings()).filter((r) => r.status !== "server_verified");
  let chunks = 0;
  for (const r of recs) chunks += (await chunksOf(r.id)).length;
  return { recordings: recs.length, chunks };
}
