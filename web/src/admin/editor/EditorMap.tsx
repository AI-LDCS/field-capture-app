import L from "leaflet";
import { Fragment, useMemo, useRef, useState } from "react";
import { CircleMarker, MapContainer, Marker, Polyline, useMapEvents } from "react-leaflet";
import type { LngLat } from "@shared/types.ts";
import { FitTo, Tiles, arrowIcon, ll } from "../../ui.tsx";
import { pointAtFraction } from "@shared/geo.ts";
import { curveOf, endOf, midAfter, seqColor, snapTarget, type Seg, type SegEnd } from "./model.ts";

/** How close, in screen pixels, a segment's end must come before it sticks. Pixels, so it feels the same at every zoom. */
const SNAP_PX = 18;

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

function Clicks({ onClick, onMove }: { onClick: (p: LngLat) => void; onMove: (p: LngLat | null) => void }) {
  useMapEvents({
    click: (e) => onClick([e.latlng.lng, e.latlng.lat]),
    mousemove: (e) => onMove([e.latlng.lng, e.latlng.lat]),
    mouseout: () => onMove(null),
  });
  return null;
}

type Props = {
  segs: Seg[];
  sel: string | null;
  selPt: number | null;
  draw: boolean;
  readOnly: boolean;
  snap: boolean;
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
  const { segs, sel, selPt, draw, readOnly, snap, fit, center, onSelect, onSelectPt, onAddPoint, onMovePoint, onInsertMid } = props;
  // while a vertex is dragged the line follows it; the edit is committed once, on drop
  const [live, setLive] = useState<{ key: string; i: number; p: LngLat; snapped: boolean } | null>(null);
  // releasing a dragged vertex also produces a map click; it must not deselect or add a point
  const lastDrag = useRef(0);
  const map = useRef<L.Map>(null);
  // the point the next click in draw mode would stick to
  const [hover, setHover] = useState<LngLat | null>(null);
  const n = segs.length;

  const snapFor = (key: string, end: SegEnd | null, p: LngLat): LngLat | null => {
    const m = map.current;
    if (!snap || readOnly || !end || !m) return null;
    const px = (a: LngLat, b: LngLat) => m.latLngToContainerPoint(ll(a)).distanceTo(m.latLngToContainerPoint(ll(b)));
    return snapTarget(segs, key, end, p, px, SNAP_PX);
  };
  // a new point becomes the segment's start if it is the first one, otherwise its new end
  const snapDrawn = (p: LngLat) => {
    const s = segs.find((x) => x.key === sel);
    return s ? snapFor(s.key, s.coords.length ? "end" : "start", p) : null;
  };
  const ring = live?.snapped ? live.p : draw ? hover : null;

  const shown = useMemo(
    () => segs.map((s) => (live && live.key === s.key ? { ...s, coords: s.coords.map((c, j) => (j === live.i ? live.p : c)) } : s)),
    [segs, live],
  );

  return (
    <div className={draw ? "drawing" : ""} style={{ height: "100%" }}>
      <MapContainer ref={map} center={[center[1], center[0]]} zoom={16} style={{ height: "100%" }}>
        <Tiles />
        <FitTo pts={fit} />
        <Clicks
          onClick={(p) => {
            if (Date.now() - lastDrag.current < 400) return;
            if (draw && !readOnly) onAddPoint(snapDrawn(p) ?? p);
            else onSelect(null);
          }}
          onMove={(p) => {
            const next = draw && p ? snapDrawn(p) : null;
            if (next !== hover) setHover(next);
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
                return m && <Marker position={ll(m.point)} interactive={false} zIndexOffset={300} icon={arrowIcon(color, m.bearing)} />;
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
                        const to = snapFor(s.key, endOf(s, i), [p.lng, p.lat]);
                        setLive({ key: s.key, i, p: to ?? [p.lng, p.lat], snapped: !!to });
                      },
                      dragend: (e) => {
                        lastDrag.current = Date.now();
                        const p = (e.target as L.Marker).getLatLng();
                        setLive(null);
                        onMovePoint(s.key, i, snapFor(s.key, endOf(s, i), [p.lng, p.lat]) ?? [p.lng, p.lat]);
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
        {ring && (
          <CircleMarker center={ll(ring)} radius={15} pathOptions={{ color: "#16a34a", weight: 3, fill: false }} interactive={false} />
        )}
      </MapContainer>
    </div>
  );
}
