import L from "leaflet";
import { Fragment, useMemo, useRef, useState } from "react";
import { CircleMarker, MapContainer, Marker, Polyline, useMapEvents } from "react-leaflet";
import type { LngLat } from "@shared/types.ts";
import { FitTo, Tiles, ll } from "../ui.tsx";
import { curveOf, midAfter, pointAtFraction, seqColor, type Seg } from "./model.ts";

const icons = new Map<string, L.DivIcon>();
function icon(html: string, size: number, cls = ""): L.DivIcon {
  const k = `${cls}|${size}|${html}`;
  let i = icons.get(k);
  if (!i) {
    i = L.divIcon({ className: cls, html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
    icons.set(k, i);
  }
  return i;
}

function Clicks({ onClick }: { onClick: (p: LngLat) => void }) {
  useMapEvents({ click: (e) => onClick([e.latlng.lng, e.latlng.lat]) });
  return null;
}

type Props = {
  segs: Seg[];
  sel: string | null;
  selPt: number | null;
  draw: boolean;
  readOnly: boolean;
  fit: LngLat[] | null;
  center: LngLat;
  onSelect: (key: string | null) => void;
  onSelectPt: (i: number | null) => void;
  onAddPoint: (p: LngLat) => void;
  onMovePoint: (key: string, i: number, p: LngLat) => void;
  onInsertMid: (key: string, at: number, p: LngLat) => void;
};

/** The map: numbered, coloured, directed segments. The selected one gets draggable vertices. */
export default function EditorMap(props: Props) {
  const { segs, sel, selPt, draw, readOnly, fit, center, onSelect, onSelectPt, onAddPoint, onMovePoint, onInsertMid } = props;
  // while a vertex is dragged the line follows it; the edit is committed once, on drop
  const [live, setLive] = useState<{ key: string; i: number; p: LngLat } | null>(null);
  // releasing a dragged vertex also produces a map click; it must not deselect or add a point
  const lastDrag = useRef(0);
  const n = segs.length;

  const shown = useMemo(
    () => segs.map((s) => (live && live.key === s.key ? { ...s, coords: s.coords.map((c, j) => (j === live.i ? live.p : c)) } : s)),
    [segs, live],
  );

  return (
    <div className={draw ? "drawing" : ""} style={{ height: "100%" }}>
      <MapContainer center={[center[1], center[0]]} zoom={16} style={{ height: "100%" }}>
        <Tiles />
        <FitTo pts={fit} />
        <Clicks
          onClick={(p) => {
            if (Date.now() - lastDrag.current < 400) return;
            if (draw && !readOnly) onAddPoint(p);
            else onSelect(null);
          }}
        />

        {shown.map((s, i) => {
          const color = seqColor(i, n);
          const on = s.key === sel;
          const line = curveOf(s).line;
          const pos = line.map(ll);
          const dash = s.required ? undefined : "9 9";
          return (
            <Fragment key={s.key}>
              {/* always created first so it stays under the line; only visible while selected */}
              {pos.length > 1 && (
                <Polyline positions={pos} pathOptions={{ color: "#fff", weight: 13, opacity: on ? 0.9 : 0 }} interactive={false} />
              )}
              <Polyline
                positions={pos}
                pathOptions={{ color, weight: on ? 8 : 6, opacity: on ? 1 : 0.8, dashArray: dash }}
                eventHandlers={{
                  click: (e) => {
                    if (!draw) {
                      L.DomEvent.stopPropagation(e);
                      onSelect(s.key);
                      onSelectPt(null);
                    }
                  },
                }}
              />
              {line.length > 0 && (
                <Marker
                  position={ll(line[0])}
                  interactive={false}
                  zIndexOffset={400}
                  icon={icon(`<span style="background:${color}">${i + 1}</span>`, 26, "seg-badge")}
                />
              )}
              {(() => {
                const m = pointAtFraction(line, 0.5);
                return (
                  m && (
                    <Marker
                      position={ll(m.point)}
                      interactive={false}
                      zIndexOffset={300}
                      icon={icon(`<span style="color:${color};transform:rotate(${Math.round(m.bearing)}deg)">▲</span>`, 22, "seg-arrow")}
                    />
                  )
                );
              })()}
            </Fragment>
          );
        })}

        {!readOnly &&
          sel &&
          shown
            .filter((s) => s.key === sel)
            .map((s) => (
              <Fragment key={`edit-${s.key}`}>
                {!draw &&
                  s.coords.slice(0, -1).map((_, i) => {
                    const m = midAfter(s, i);
                    return (
                      <Marker
                        key={`mid-${i}`}
                        position={ll(m)}
                        zIndexOffset={500}
                        icon={icon("+", 18, "vtx-mid")}
                        title="Add a point here"
                        eventHandlers={{ click: () => onInsertMid(s.key, i + 1, m) }}
                      />
                    );
                  })}
                {s.coords.map((c, i) => (
                  <Marker
                    key={`v-${i}`}
                    position={ll(c)}
                    draggable
                    zIndexOffset={600}
                    icon={icon("", 16, `vtx${i === 0 ? " first" : ""}${i === s.coords.length - 1 && i > 0 ? " last" : ""}`)}
                    eventHandlers={{
                      click: () => onSelectPt(i),
                      dragstart: () => {
                        lastDrag.current = Date.now();
                        onSelectPt(i);
                      },
                      drag: (e) => {
                        const p = (e.target as L.Marker).getLatLng();
                        setLive({ key: s.key, i, p: [p.lng, p.lat] });
                      },
                      dragend: (e) => {
                        lastDrag.current = Date.now();
                        const p = (e.target as L.Marker).getLatLng();
                        setLive(null);
                        onMovePoint(s.key, i, [p.lng, p.lat]);
                      },
                    }}
                  />
                ))}
                {/* the picked vertex is marked by a ring, never by changing its icon: a new icon would cancel an active drag */}
                {selPt !== null && s.coords[selPt] && (
                  <CircleMarker
                    center={ll(s.coords[selPt])}
                    radius={13}
                    pathOptions={{ color: "#dc2626", weight: 3, fill: false }}
                    interactive={false}
                  />
                )}
              </Fragment>
            ))}
      </MapContainer>
    </div>
  );
}
