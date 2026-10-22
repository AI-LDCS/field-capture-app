import { useEffect, useState } from "react";
import { CircleMarker, MapContainer, Polyline, useMap, useMapEvents } from "react-leaflet";
import { lineLengthM } from "@shared/geo.ts";
import type { LngLat, RouteVersion, SegmentInput } from "@shared/types.ts";
import { api } from "./api.ts";
import { Badge, Card, FitTo, Tiles, km, ll, useLoad } from "./ui.tsx";

type Seg = { name: string; required: boolean; coords: LngLat[] };

/**
 * One point per line as "lat, lng" (comma, space, tab or semicolon). A blank line starts the
 * next segment. A line "optional" (or "required") before a segment sets its type.
 */
export function parsePoints(text: string): { segs: Seg[]; errors: string[] } {
  const segs: Seg[] = [];
  const errors: string[] = [];
  let cur: LngLat[] = [];
  let required = true;
  const flush = (line: number) => {
    if (cur.length === 1) errors.push(`segment ending near line ${line}: needs at least 2 points`);
    else if (cur.length > 1) segs.push({ name: "", required, coords: cur });
    cur = [];
    required = true;
  };
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return flush(i);
    if (/^#?\s*(optional|required)\s*$/i.test(line)) {
      if (cur.length) flush(i);
      required = /required/i.test(line);
      return;
    }
    const nums = line.split(/[\s,;]+/).filter(Boolean).map(Number);
    if (nums.length !== 2 || nums.some((n) => !Number.isFinite(n))) return void errors.push(`line ${i + 1}: expected "lat, lng"`);
    const [lat, lng] = nums;
    if (Math.abs(lat) > 90) return void errors.push(`line ${i + 1}: latitude ${lat} out of range (lat first, then lng)`);
    if (Math.abs(lng) > 180) return void errors.push(`line ${i + 1}: longitude ${lng} out of range`);
    cur.push([lng, lat]);
  });
  flush(lines.length);
  return { segs, errors };
}

function Clicks({ onAdd }: { onAdd: (p: LngLat) => void }) {
  useMapEvents({ click: (e) => onAdd([e.latlng.lng, e.latlng.lat]) });
  return null;
}
function Locate() {
  const map = useMap();
  useEffect(() => {
    navigator.geolocation?.getCurrentPosition((p) => map.setView([p.coords.latitude, p.coords.longitude], 17), () => {}, { timeout: 5000 });
  }, [map]);
  return null;
}
function CenterWatch({ onCenter }: { onCenter: (c: LngLat) => void }) {
  const map = useMap();
  useEffect(() => { onCenter([map.getCenter().lng, map.getCenter().lat]); }, [map]);
  useMapEvents({ moveend: () => onCenter([map.getCenter().lng, map.getCenter().lat]) });
  return null;
}

export function NewRoute() {
  return <Editor />;
}
export function EditVersion({ versionId }: { versionId: string }) {
  const { data, err } = useLoad(() => api.version(versionId), [versionId]);
  if (err) return <p className="err">{err}</p>;
  if (!data) return <p>Loading…</p>;
  return <Editor version={data} />;
}

function Editor({ version }: { version?: RouteVersion }) {
  const readOnly = !!version && version.status !== "draft";
  const [name, setName] = useState(version?.routeName ?? "");
  const [segs, setSegs] = useState<Seg[]>(version?.segments.map((s) => ({ name: s.name, required: s.required, coords: s.coords })) ?? []);
  const [draft, setDraft] = useState<LngLat[]>([]);
  const [draftRequired, setDraftRequired] = useState(true);
  const [center, setCenter] = useState<LngLat>([100.5018, 13.7563]);
  const [paste, setPaste] = useState("");
  const [pasteErrors, setPasteErrors] = useState<string[]>([]);
  const [fit, setFit] = useState<LngLat[] | null>(version ? version.segments.flatMap((s) => s.coords) : null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [vid, setVid] = useState(version?.id);

  const toInput = (list: Seg[]): SegmentInput[] => list.map((s) => ({ name: s.name, required: s.required, coords: s.coords }));
  const withDraft = () => (draft.length >= 2 ? [...segs, { name: "", required: draftRequired, coords: draft }] : segs);

  const commitDraft = () => {
    if (draft.length < 2) return;
    setSegs([...segs, { name: "", required: draftRequired, coords: draft }]);
    setDraft([]);
    setDraftRequired(true);
  };
  const importPoints = () => {
    const { segs: added, errors } = parsePoints(paste);
    setPasteErrors(errors.length || added.length ? errors : ["no points found"]);
    if (errors.length || !added.length) return;
    setSegs([...segs, ...added]);
    setFit(added.flatMap((x) => x.coords));
    setPaste("");
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= segs.length) return;
    const next = [...segs];
    [next[i], next[j]] = [next[j], next[i]];
    setSegs(next);
  };
  const sample = () => {
    const dLng = 300 / (111_320 * Math.cos((center[1] * Math.PI) / 180));
    const mk = (i: number): LngLat[] => [[center[0] + dLng * i, center[1]], [center[0] + dLng * (i + 0.5), center[1] + 0.0008], [center[0] + dLng * (i + 1), center[1]]];
    setSegs([{ name: "", required: true, coords: mk(0) }, { name: "", required: false, coords: mk(1) }, { name: "", required: true, coords: mk(2) }]);
    setName(name || "Sample route");
  };

  const save = async (): Promise<string | null> => {
    if (!name.trim()) { setMsg("Give the route a name"); return null; }
    const all = withDraft();
    setBusy(true);
    setMsg("");
    try {
      let id = vid;
      if (!id) {
        const v = await api.createRoute(name, toInput(all));
        id = v.id;
        setVid(id);
      } else {
        await api.saveDraft(id, name, toInput(all));
      }
      setSegs(all);
      setDraft([]);
      return id;
    } catch (x: any) { setMsg(x.message); return null; } finally { setBusy(false); }
  };
  const saveAndStay = async () => { if (await save()) setMsg("Draft saved"); };
  const saveAndPublish = async () => {
    const id = await save();
    if (!id) return;
    try { await api.publish(id); location.hash = "#/routes"; } catch (x: any) { setMsg(x.message); }
  };

  const total = segs.reduce((a, s) => a + lineLengthM(s.coords), 0);

  return (
    <>
      <Card title={readOnly ? `${version!.routeName} · v${version!.version}` : version ? `Edit draft · v${version.version}` : "New route"}
        right={version && <Badge s={version.status} />}>
        {readOnly
          ? <p className="muted small">This version is {version!.status} and cannot be changed. Make a new version from the Routes page to edit.</p>
          : <p className="muted small">Tap the map to add points. Finish each segment, then draw the next. Segments are walked in the order listed.</p>}
        {!readOnly && <label>Route name<input value={name} onChange={(e) => setName(e.target.value)} /></label>}
      </Card>

      <div className="map">
        <MapContainer center={[center[1], center[0]]} zoom={16} style={{ height: "100%" }}>
          <Tiles />
          {!version && <Locate />}
          <FitTo pts={fit} />
          <CenterWatch onCenter={setCenter} />
          {!readOnly && <Clicks onAdd={(p) => setDraft((d) => [...d, p])} />}
          {segs.map((s, i) => (
            <Polyline key={i} positions={s.coords.map(ll)} pathOptions={{ color: s.required ? "#1d4ed8" : "#ea580c", weight: 5, dashArray: s.required ? undefined : "8 8" }} />
          ))}
          {draft.length > 0 && <Polyline positions={draft.map(ll)} pathOptions={{ color: "#c026d3", weight: 5 }} />}
          {draft.map((p, i) => <CircleMarker key={i} center={ll(p)} radius={4} pathOptions={{ color: "#c026d3" }} />)}
        </MapContainer>
      </div>

      {!readOnly && (
        <>
          <Card title={`Current segment (${draft.length} points${draft.length > 1 ? `, ${Math.round(lineLengthM(draft))} m` : ""})`}>
            <label className="check"><input type="checkbox" checked={draftRequired} onChange={(e) => setDraftRequired(e.target.checked)} /> Required</label>
            <div className="row wrap">
              <button onClick={commitDraft} disabled={draft.length < 2}>Finish segment</button>
              <button className="ghost" onClick={() => setDraft(draft.slice(0, -1))} disabled={!draft.length}>Undo point</button>
              {!version && <button className="ghost" onClick={sample}>Insert sample</button>}
            </div>
          </Card>

          <Card title="Insert from lat/long points">
            <p className="muted small">One point per line as <code>lat, lng</code> in route order. A blank line starts a new segment. Put <code>optional</code> on its own line before a segment to mark it optional.</p>
            <textarea rows={5} placeholder={"13.7563, 100.5018\n13.7571, 100.5030\n\noptional\n13.7580, 100.5045\n13.7590, 100.5060"} value={paste} onChange={(e) => setPaste(e.target.value)} />
            {pasteErrors.length > 0 && <ul className="err small">{pasteErrors.slice(0, 6).map((e) => <li key={e}>{e}</li>)}</ul>}
            <div className="row"><button onClick={importPoints} disabled={!paste.trim()}>Add as segments</button></div>
          </Card>
        </>
      )}

      <Card title={`Segments · ${segs.length} · ${km(total)}`}>
        {segs.length === 0 && <p className="muted">None yet.</p>}
        {segs.map((s, i) => (
          <div key={i} className="item row between">
            <div>
              #{i + 1} <Badge s={s.required ? "required" : "optional"} /> <span className="muted small">{Math.round(lineLengthM(s.coords))} m · {s.coords.length} points</span>
            </div>
            {!readOnly && (
              <div className="row wrap">
                <label className="check"><input type="checkbox" checked={s.required} onChange={(e) => setSegs(segs.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} /> required</label>
                <button className="ghost" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                <button className="ghost" onClick={() => move(i, 1)} disabled={i === segs.length - 1}>↓</button>
                <button className="ghost danger-text" onClick={() => setSegs(segs.filter((_, j) => j !== i))}>✕</button>
              </div>
            )}
          </div>
        ))}
        {msg && <p className={msg === "Draft saved" ? "ok" : "err"}>{msg}</p>}
        <div className="row wrap">
          {!readOnly && <button onClick={() => void saveAndStay()} disabled={busy}>Save draft</button>}
          {!readOnly && <button className="ghost" onClick={() => void saveAndPublish()} disabled={busy}>Save &amp; publish</button>}
          <a className="btn ghost" href="#/routes">{readOnly ? "Back" : "Close"}</a>
        </div>
      </Card>
    </>
  );
}
