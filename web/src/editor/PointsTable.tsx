import { useEffect, useState } from "react";
import type { LngLat } from "@shared/types.ts";
import { parseLatLng, validLat, validLng, type Seg } from "./model.ts";

/** One number the user can type. Applied on Enter or blur when valid; Escape puts the old value back. */
function NumInput({ value, valid, onCommit, label }: { value: number; valid: (v: number) => boolean; onCommit: (v: number) => void; label: string }) {
  const shown = value.toFixed(7).replace(/0+$/, "").replace(/\.$/, ".0");
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const num = Number(text);
  const bad = text.trim() === "" || !Number.isFinite(num) || !valid(num);
  const apply = () => { if (!bad && num !== value) onCommit(num); else if (bad) setText(shown); };
  return (
    <input className={bad ? "bad" : ""} inputMode="decimal" aria-label={label} value={text}
      onChange={(e) => setText(e.target.value)} onBlur={apply}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setText(shown); }} />
  );
}

type Props = {
  seg: Seg;
  selPt: number | null;
  onSelectPt: (i: number) => void;
  onSetPoint: (i: number, p: LngLat) => void;
  onInsertAfter: (i: number) => void;
  onRemovePoint: (i: number) => void;
  onAddPoint: (p: LngLat) => void;
  onSplit: (i: number) => void;
};

/** The selected segment's points as editable latitude / longitude. */
export default function PointsTable({ seg, selPt, onSelectPt, onSetPoint, onInsertAfter, onRemovePoint, onAddPoint, onSplit }: Props) {
  const [add, setAdd] = useState("");
  const [err, setErr] = useState("");
  const submit = () => {
    const r = parseLatLng(add);
    if ("error" in r) return setErr(r.error);
    setErr("");
    setAdd("");
    onAddPoint(r.p);
  };
  const last = seg.coords.length - 1;
  return (
    <>
      <div className="ptable">
        <div className="phead"><span>#</span><span>Latitude</span><span>Longitude</span><span /></div>
        {seg.coords.map((c, i) => (
          <div key={i} className={`prow${i === selPt ? " on" : ""}`} onClick={() => onSelectPt(i)}>
            <span className="pidx">{i === 0 ? "S" : i === last ? "E" : i + 1}</span>
            <NumInput label={`Latitude of point ${i + 1}`} value={c[1]} valid={validLat} onCommit={(v) => onSetPoint(i, [c[0], v])} />
            <NumInput label={`Longitude of point ${i + 1}`} value={c[0]} valid={validLng} onCommit={(v) => onSetPoint(i, [v, c[1]])} />
            <span className="pact">
              {i < last && <button className="ghost small" title="Add a point after this one" onClick={(e) => { e.stopPropagation(); onInsertAfter(i); }}>+</button>}
              {i > 0 && i < last && <button className="ghost small" title="Split the segment here" onClick={(e) => { e.stopPropagation(); onSplit(i); }}>✂</button>}
              <button className="ghost small danger-text" title="Delete this point" onClick={(e) => { e.stopPropagation(); onRemovePoint(i); }}>✕</button>
            </span>
          </div>
        ))}
        {seg.coords.length === 0 && <p className="muted small">No points. Click the map in draw mode, or type one below.</p>}
      </div>
      <div className="row">
        <input value={add} placeholder="Add point: lat, lng  e.g. 13.7563, 100.5018" onChange={(e) => { setAdd(e.target.value); setErr(""); }}
          onKeyDown={(e) => e.key === "Enter" && submit()} />
        <button onClick={submit} disabled={!add.trim()}>Add</button>
      </div>
      {err && <p className="err small">{err}</p>}
    </>
  );
}
