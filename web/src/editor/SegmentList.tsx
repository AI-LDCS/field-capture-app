import { useState } from "react";
import { Badge, km } from "../ui.tsx";
import { segLength, seqColor, type Seg } from "./model.ts";

type Props = {
  segs: Seg[];
  sel: string | null;
  readOnly: boolean;
  onSelect: (key: string) => void;
  onMove: (from: number, to: number) => void;
  onChange: (key: string, patch: Partial<Seg>) => void;
  onRemove: (key: string) => void;
  onReverse: (key: string) => void;
  onJoin: (key: string) => void;
};

/** Walking order = list order. Drag the grip to reorder, or use the arrows. */
export default function SegmentList({ segs, sel, readOnly, onSelect, onMove, onChange, onRemove, onReverse, onJoin }: Props) {
  const [from, setFrom] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const end = () => { setFrom(null); setOver(null); };

  if (segs.length === 0) return <p className="muted">No segments yet. Use “New segment” and click the map, or paste coordinates below.</p>;

  return (
    <ol className="seglist">
      {segs.map((s, i) => {
        const on = s.key === sel;
        const dropping = from !== null && over === i && from !== i;
        return (
          <li key={s.key}
            className={`segitem${on ? " on" : ""}${from === i ? " dragging" : ""}${dropping ? (from! < i ? " drop-after" : " drop-before") : ""}`}
            style={{ borderLeftColor: seqColor(i, segs.length) }}
            onClick={() => onSelect(s.key)}
            onDragOver={(e) => { if (from !== null) { e.preventDefault(); setOver(i); } }}
            onDrop={(e) => { e.preventDefault(); if (from !== null) onMove(from, i); end(); }}>
            <div className="row between">
              <div className="row nogap">
                {!readOnly && (
                  <span className="grip" title="Drag to reorder" draggable
                    onDragStart={(e) => {
                      setFrom(i);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", String(i));
                      const li = (e.target as HTMLElement).closest("li");
                      if (li) e.dataTransfer.setDragImage(li, 16, 16);
                    }}
                    onDragEnd={end}>⋮⋮</span>
                )}
                <span className="seqnum" style={{ background: seqColor(i, segs.length) }}>{i + 1}</span>
                <span className="segname">{s.name || `Segment ${i + 1}`}</span>
              </div>
              <div className="row nogap">
                <Badge s={s.required ? "required" : "optional"} />
                <span className="muted small">{km(segLength(s))}</span>
              </div>
            </div>

            {on && (
              <div className="segdetail" onClick={(e) => e.stopPropagation()}>
                {s.coords.length < 2 && <p className="err small">Needs at least 2 points. Click the map or add coordinates below.</p>}
                {!readOnly ? (
                  <>
                    <div className="grid2">
                      <label>Name<input value={s.name} placeholder={`Segment ${i + 1}`} maxLength={80} onChange={(e) => onChange(s.key, { name: e.target.value })} /></label>
                      <label>Must cover (%)
                        <input type="number" min={50} max={100} step={1} value={Math.round(s.minCoverage * 100)}
                          onChange={(e) => onChange(s.key, { minCoverage: Math.min(1, Math.max(0.5, Number(e.target.value) / 100 || 0.9)) })} />
                      </label>
                    </div>
                    <div className="seg-toggle" role="group" aria-label="Type">
                      <button type="button" className={s.required ? "on" : ""} onClick={() => onChange(s.key, { required: true })}>Required</button>
                      <button type="button" className={!s.required ? "on" : ""} onClick={() => onChange(s.key, { required: false })}>Optional</button>
                    </div>
                    <div className="row wrap">
                      <button className="ghost small" disabled={i === 0} onClick={() => onMove(i, i - 1)}>↑ Earlier</button>
                      <button className="ghost small" disabled={i === segs.length - 1} onClick={() => onMove(i, i + 1)}>↓ Later</button>
                      <button className="ghost small" onClick={() => onReverse(s.key)}>⇄ Reverse</button>
                      <button className="ghost small" disabled={i === segs.length - 1} onClick={() => onJoin(s.key)}>⛓ Join with next</button>
                      <button className="ghost small danger-text" onClick={() => onRemove(s.key)}>Delete</button>
                    </div>
                  </>
                ) : (
                  <p className="muted small">{s.coords.length} points · must cover {Math.round(s.minCoverage * 100)}%</p>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
