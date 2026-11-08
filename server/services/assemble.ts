import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { audit } from "./audit.ts";
import { config } from "../config.ts";
import { q, q1 } from "../db.ts";
import { deleteObjects, getObject, multipart } from "./storage.ts";

/**
 * Builds the playable file of a verified recording from its chunks, off the request path.
 * The finalize call only checks the manifest; this job does the heavy work and can be repeated:
 * on start, anything left "running" by a crash goes back to "pending".
 */
let timer: NodeJS.Timeout | null = null;
let active = 0; // builders running now, at most config.assembly.concurrency
let again = false; // work may have arrived since a builder last looked

export const extFor = (mime: string) => (mime.includes("mp4") ? "mp4" : "webm");
const baseMime = (mime: string) => mime.split(";")[0] || "video/webm";

export function startAssembler() {
  void q("UPDATE recordings SET assembly_state = 'pending' WHERE assembly_state = 'running'");
  timer ??= setInterval(() => void kickAssembler(), config.assembly.pollMs);
  void kickAssembler();
}
export function stopAssembler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Run the queue now (also called right after a recording is verified). Starts builders up to the
 * concurrency limit; each claims one pending recording at a time (SKIP LOCKED, so never the same one
 * twice) until none is left. Resolves when the builders this call started have finished.
 */
export async function kickAssembler() {
  again = true;
  const started: Promise<void>[] = [];
  while (active < config.assembly.concurrency) {
    active++;
    started.push(builder());
  }
  await Promise.all(started);
}

async function builder() {
  try {
    for (;;) {
      again = false;
      const rec = await q1(
        "UPDATE recordings SET assembly_state = 'running', assembly_error = NULL WHERE id = (SELECT id FROM recordings WHERE assembly_state = 'pending' ORDER BY verified_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id",
      ).catch(() => null);
      if (rec) {
        await assemble(rec.id).catch(() => {});
        continue;
      }
      // checked and released in the same tick, so a kick that arrives now either sees `again` taken or a free slot
      if (!again) return;
    }
  } finally {
    active--;
  }
}

/** Runs `f` over the items with at most `width` in flight, handing results back in order. */
async function inOrder<T, R>(items: T[], width: number, f: (x: T) => Promise<R>, use: (r: R) => void) {
  const inflight: Promise<R>[] = [];
  let next = 0;
  const fill = () => {
    while (next < items.length && inflight.length < width) {
      const p = f(items[next++]);
      p.catch(() => {}); // seen when awaited below; this only stops an early failure being reported as unhandled
      inflight.push(p);
    }
  };
  fill();
  while (inflight.length) {
    use(await inflight.shift()!);
    fill();
  }
}

async function remux(input: string, output: string, ext: string): Promise<boolean> {
  return new Promise((resolve) => {
    // copy the streams, but write a proper duration and seek index; MediaRecorder files have neither
    const args = ["-v", "error", "-y", "-i", input, "-c", "copy", ...(ext === "mp4" ? ["-movflags", "+faststart"] : []), output];
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", () => resolve(false)); // ffmpeg not installed
    p.on("close", (code) => resolve(code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0));
  });
}

async function assemble(id: string) {
  const rec = await q1("SELECT * FROM recordings WHERE id = $1", [id]);
  if (!rec) return;
  const ext = extFor(rec.mime);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
  const raw = path.join(tmp, `raw.${ext}`);
  const out = path.join(tmp, `out.${ext}`);
  const key = `rec/${id}/video.${ext}`;
  let mp: Awaited<ReturnType<typeof multipart>> | null = null;
  try {
    // 1. chunks -> one file, checking every chunk against the hash the phone sent
    const chunks = await q("SELECT seq, sha256, object_key FROM recording_chunks WHERE recording_id = $1 ORDER BY seq", [id]);
    if (chunks.length !== rec.chunk_count || chunks.some((c, i) => c.seq !== i))
      throw new Error("chunk list does not match the verified manifest");
    const fd = fs.openSync(raw, "w");
    try {
      // several chunks are read at once (storage round trips dominate), but written strictly in order
      await inOrder(
        chunks,
        config.assembly.fetchAhead,
        async (c) => {
          const { body } = await getObject(c.object_key);
          const parts: Buffer[] = [];
          for await (const p of body) parts.push(Buffer.from(p));
          const buf = Buffer.concat(parts);
          if (crypto.createHash("sha256").update(buf).digest("hex") !== c.sha256) throw new Error(`chunk ${c.seq} is corrupt in storage`);
          return buf;
        },
        (buf) => fs.writeSync(fd, buf),
      );
    } finally {
      fs.closeSync(fd);
    }

    // 2. optional remux (duration + seeking); on any trouble keep the plain concatenation
    let file = raw;
    if (config.assembly.remux && (await remux(raw, out, ext))) file = out;

    // 3. upload in parts of at least 5 MiB, hashing as we go
    const hash = crypto.createHash("sha256");
    mp = await multipart(key, baseMime(rec.mime));
    const rs = fs.createReadStream(file, { highWaterMark: config.assembly.partBytes });
    let total = 0;
    const sending = new Set<Promise<void>>();
    let failed: unknown = null;
    for await (const part of rs) {
      const b = Buffer.from(part as Buffer);
      hash.update(b);
      total += b.length;
      const up = mp.part(b).then(
        () => void sending.delete(up),
        (e) => {
          failed ??= e;
          sending.delete(up);
        },
      );
      sending.add(up);
      if (sending.size >= config.assembly.uploadsInFlight) await Promise.race(sending);
      if (failed) break;
    }
    rs.destroy();
    await Promise.all(sending);
    if (failed) throw failed;
    await mp.complete();
    mp = null;

    // 4. only now is the chunk copy redundant
    await q(
      "UPDATE recordings SET assembly_state = 'done', file_key = $1, file_bytes = $2, file_sha256 = $3, file_mime = $4, chunks_purged = true WHERE id = $5",
      [key, total, hash.digest("hex"), baseMime(rec.mime), id],
    );
    await deleteObjects(chunks.map((c) => c.object_key));
    await audit(null, "recording_assembled", { type: "recording", id }, { bytes: total, remuxed: file === out });
  } catch (e) {
    if (mp) await mp.abort();
    const msg = e instanceof Error ? e.message : String(e);
    await q("UPDATE recordings SET assembly_state = 'failed', assembly_error = $1 WHERE id = $2", [msg.slice(0, 500), id]);
    await audit(null, "recording_assembly_failed", { type: "recording", id }, { error: msg });
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
