import { useEffect, useMemo, useState } from "react";
import type { LngLat, RouteVersion } from "@shared/types.ts";
import { api } from "./api.ts";
import EditorMap from "./editor/EditorMap.tsx";
import {
  commit, hist, incompleteSegments, insertPoint, joinWithNext, makeSeg, midpoint, moveSeg, parsePoints, redo, removePoint,
  removeSeg, reverseSeg, setPoint, splitAt, toInput, totalLength, undo, updateSeg, type History, type Seg,
} from "./editor/model.ts";
import PointsTable from "./editor/PointsTable.tsx";
import SegmentList from "./editor/SegmentList.tsx";
import { Badge, Card, km, useLoad } from "./ui.tsx";

export function NewRoute() {
  return <Editor />;
}
export function EditVersion({ versionId }: { versionId: string }) {
  const { data, err } = useLoad(() => api.version(versionId), [versionId]);
  if (err) return <p className="err">{err}</p>;
  if (!data) return <p>Loading…</p>;
  return <Editor version={data} />;
}

const fromVersion = (v?: RouteVersion): Seg[] =>
  (v?.segments ?? []).map((s) => makeSeg(s.coords, { name: s.name, required: s.required, minCoverage: s.minCoverageRatio }));

function Editor({ version }: { version?: RouteVersion }) {
  const readOnly = !!version && version.status !== "draft";
  const [name, setName] = useState(version?.routeName ?? "");
  const [h, setH] = useState<History<Seg[]>>(() => hist(fromVersion(version)));
  const segs = h.present;
  const [sel, setSel] = useState<string | null>(null);
  const [selPt, setSelPt] = useState<number | null>(null);
  const [draw, setDraw] = useState(false);
  const [fit, setFit] = useState<LngLat[] | null>(version ? version.segments.flatMap((s) => s.coords) : null);
  const [center, setCenter] = useState<LngLat>([100.5018, 13.7563]);
  const [bulk, setBulk] = useState("");
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [vid, setVid] = useState(version?.id);
  const snapshot = (n: string, s: Seg[]) => JSON.stringify([n.trim(), toInput(s)]);
  const [saved, setSaved] = useState(() => snapshot(version?.routeName ?? "", fromVersion(version)));
  const dirty = !readOnly && snapshot(name, segs) !== saved;

  const edit = (next: Seg[]) => setH((x) => commit(x, next));
  const selSeg = segs.find((s) => s.key === sel) ?? null;

  // start near the admin on a brand-new route
  useEffect(() => {
    if (version) return;
    navigator.geolocation?.getCurrentPosition((p) => { const c: LngLat = [p.coords.longitude, p.coords.latitude]; setCenter(c); setFit([c, c]); }, () => {}, { timeout: 4000 });
  }, []);

  // leaving with unsaved edits asks first
  useEffect(() => {
    if (!dirty) return;
    const f = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", f);
    return () => removeEventListener("beforeunload", f);
  }, [dirty]);

  // keyboard: Esc stops drawing, Delete removes the picked point, Ctrl/Cmd+Z / Shift+Z undo / redo
  useEffect(() => {
    if (readOnly) return;
    const f = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? "");
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); setH((x) => (e.shiftKey ? redo(x) : undo(x))); }
      else if (mod && e.key.toLowerCase() === "y" && !typing) { e.preventDefault(); setH(redo); }
      else if (e.key === "Escape") setDraw(false);
      else if ((e.key === "Delete" || e.key === "Backspace") && !typing && sel && selPt !== null) {
        e.preventDefault();
        edit(removePoint(segs, sel, selPt));
        setSelPt(null);
      }
    };
    addEventListener("keydown", f);
    return () => removeEventListener("keydown", f);
  });

  const pick = (key: string | null) => { setSel(key); setSelPt(null); if (!key) setDraw(false); };

  const newSegment = () => {
    const s = makeSeg([]);
    edit([...segs, s]);
    setSel(s.key); setSelPt(null); setDraw(true);
  };
  const addPoint = (p: LngLat) => {
    if (!sel) return;
    const at = segs.find((s) => s.key === sel)?.coords.length ?? 0;
    edit(insertPoint(segs, sel, at, p));
    setSelPt(at);
  };
  const split = (i: number) => {
    if (!sel) return;
    const r = splitAt(segs, sel, i);
    if (r.newKey) { edit(r.segs); setSelPt(null); }
  };
  const importBulk = () => {
    const { segs: added, errors } = parsePoints(bulk);
    setBulkErrors(errors.length || added.length ? errors : ["no points found"]);
    if (errors.length || !added.length) return;
    edit([...segs, ...added]);
    setFit(added.flatMap((x) => x.coords));
    setSel(added[0].key);
    setBulk("");
  };
  const sample = () => {
    const dLng = 300 / (111_320 * Math.cos((center[1] * Math.PI) / 180));
    const mk = (i: number): LngLat[] => [[center[0] + dLng * i, center[1]], [center[0] + dLng * (i + 0.5), center[1] + 0.0008], [center[0] + dLng * (i + 1), center[1]]];
    const next = [makeSeg(mk(0)), makeSeg(mk(1), { required: false }), makeSeg(mk(2))];
    edit(next);
    setFit(next.flatMap((s) => s.coords));
    if (!name) setName("Sample route");
  };

  const save = async (): Promise<string | null> => {
    setMsg(null);
    if (!name.trim()) { setMsg({ ok: false, text: "Give the route a name" }); return null; }
    const bad = incompleteSegments(segs);
    if (bad.length) { setMsg({ ok: false, text: `Segment ${bad.join(", ")} needs at least 2 points (or delete it)` }); setSel(segs[bad[0] - 1].key); return null; }
    setBusy(true);
    try {
      let id = vid;
      if (!id) { id = (await api.createRoute(name, toInput(segs))).id; setVid(id); }
      else await api.saveDraft(id, name, toInput(segs));
      setSaved(snapshot(name, segs));
      return id;
    } catch (x: any) { setMsg({ ok: false, text: x.message }); return null; } finally { setBusy(false); }
  };
  const saveDraft = async () => { if (await save()) setMsg({ ok: true, text: "Draft saved" }); };
  const savePublish = async () => {
    const id = await save();
    if (!id) return;
    try { await api.publish(id); location.hash = "#/routes"; } catch (x: any) { setMsg({ ok: false, text: x.message }); }
  };

  const revert = () => {
    if (!confirm("Discard all unsaved changes?")) return;
    setH(hist(fromVersion(version)));
    setName(version?.routeName ?? "");
    setSel(null); setSelPt(null); setDraw(false);
  };

  const total = useMemo(() => totalLength(segs), [segs]);

  return (
    <div className="editor">
      <div className="ed-map">
        <EditorMap segs={segs} sel={sel} selPt={selPt} draw={draw} readOnly={readOnly} fit={fit} center={center}
          onSelect={pick} onSelectPt={setSelPt} onAddPoint={addPoint}
          onMovePoint={(k, i, p) => { edit(setPoint(segs, k, i, p)); setSelPt(i); }}
          onInsertMid={(k, at, p) => { edit(insertPoint(segs, k, at, p)); setSelPt(at); }} />
        {!readOnly && (
          <div className="ed-tools">
            <button onClick={newSegment}>＋ New segment</button>
            <button className={draw ? "on" : "ghost"} disabled={!selSeg} onClick={() => setDraw(!draw)} title="Click the map to add points to the selected segment">✎ Draw</button>
            <button className="ghost" disabled={!h.past.length} onClick={() => setH(undo)} title="Undo (Ctrl/Cmd+Z)">↶</button>
            <button className="ghost" disabled={!h.future.length} onClick={() => setH(redo)} title="Redo (Ctrl/Cmd+Shift+Z)">↷</button>
          </div>
        )}
        {draw && selSeg && <div className="ed-hint">Drawing segment {segs.indexOf(selSeg) + 1}: click the map to add points · Esc to stop</div>}
      </div>

      <div className="ed-side">
        <Card title={readOnly ? `${version!.routeName} · v${version!.version}` : version ? `Edit draft · v${version.version}` : "New route"}
          right={<>{dirty && <span className="dirty">unsaved</span>} {version && <Badge s={version.status} />}</>}>
          {readOnly
            ? <p className="muted small">This version is {version!.status} and cannot be changed. Make a new version from the Routes page to edit.</p>
            : <label>Route name<input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></label>}
          <div className="row wrap">
            {!readOnly && <button onClick={() => void saveDraft()} disabled={busy || !dirty && !!vid}>Save draft</button>}
            {!readOnly && <button className="ghost" onClick={() => void savePublish()} disabled={busy}>Save &amp; publish</button>}
            {!readOnly && dirty && <button className="ghost" onClick={revert}>Revert</button>}
            <a className="btn ghost" href="#/routes">{readOnly ? "Back" : "Close"}</a>
          </div>
          {msg && <p className={msg.ok ? "ok" : "err"}>{msg.text}</p>}
        </Card>

        <Card title={`Segments · ${segs.length} · ${km(total)}`} right={!readOnly && !version && segs.length === 0 && <button className="ghost small" onClick={sample}>Insert sample</button>}>
          {!readOnly && <p className="muted small">The list order is the walking order. Drag the ⋮⋮ grip to reorder; colours and numbers on the map follow.</p>}
          <SegmentList segs={segs} sel={sel} readOnly={readOnly} onSelect={pick}
            onMove={(from, to) => edit(moveSeg(segs, from, to))}
            onChange={(k, patch) => edit(updateSeg(segs, k, patch))}
            onRemove={(k) => { edit(removeSeg(segs, k)); pick(null); }}
            onReverse={(k) => edit(reverseSeg(segs, k))}
            onJoin={(k) => edit(joinWithNext(segs, k))} />
          {!readOnly && <div className="row"><button onClick={newSegment}>＋ New segment</button></div>}
        </Card>

        {!readOnly && selSeg && (
          <Card title={`Points of segment ${segs.indexOf(selSeg) + 1} (${selSeg.coords.length})`}>
            <p className="muted small">Edit the numbers, or drag the dots on the map. Click a + on the line to add a point. Select a point and press Delete to remove it.</p>
            <PointsTable seg={selSeg} selPt={selPt} onSelectPt={setSelPt}
              onSetPoint={(i, p) => edit(setPoint(segs, selSeg.key, i, p))}
              onInsertAfter={(i) => { edit(insertPoint(segs, selSeg.key, i + 1, midpoint(selSeg.coords[i], selSeg.coords[i + 1]))); setSelPt(i + 1); }}
              onRemovePoint={(i) => { edit(removePoint(segs, selSeg.key, i)); setSelPt(null); }}
              onAddPoint={addPoint} onSplit={split} />
          </Card>
        )}

        {!readOnly && (
          <Card title="Paste many points">
            <p className="muted small">One point per line as <code>lat, lng</code>. A blank line starts a new segment. Put <code>optional</code> on its own line before a segment to mark it optional.</p>
            <textarea rows={5} placeholder={"13.7563, 100.5018\n13.7571, 100.5030\n\noptional\n13.7580, 100.5045\n13.7590, 100.5060"} value={bulk} onChange={(e) => setBulk(e.target.value)} />
            {bulkErrors.length > 0 && <ul className="err small">{bulkErrors.slice(0, 6).map((e) => <li key={e}>{e}</li>)}</ul>}
            <div className="row"><button onClick={importBulk} disabled={!bulk.trim()}>Add as segments</button></div>
          </Card>
        )}
      </div>
    </div>
  );
}
