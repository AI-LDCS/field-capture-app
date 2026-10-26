import { useEffect, useState, type ReactNode } from "react";
import { LayersControl, TileLayer, useMap, useMapEvents } from "react-leaflet";
import type { LngLat } from "@shared/types.ts";

export const Badge = ({ s }: { s: string }) => <span className={`badge b-${s}`}>{s.replace(/_/g, " ")}</span>;

export const fmtBytes = (n: number) =>
  n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;

export const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");
export const ll = (c: LngLat): [number, number] => [c[1], c[0]];

const LAYER_KEY = "fc-map-layer";
const saved = () => { try { return localStorage.getItem(LAYER_KEY) ?? "Satellite"; } catch { return "Satellite"; } };

/** Street, terrain or satellite base map; satellite by default; the choice is remembered. */
export function Tiles() {
  useMapEvents({ baselayerchange: (e) => { try { localStorage.setItem(LAYER_KEY, e.name); } catch { /* ignore */ } } });
  const cur = saved();
  return (
    <LayersControl position="topright">
      <LayersControl.BaseLayer name="Street" checked={cur === "Street"}>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>' url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19} />
      </LayersControl.BaseLayer>
      <LayersControl.BaseLayer name="Terrain" checked={cur === "Terrain"}>
        <TileLayer
          attribution='Map data &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>, SRTM | Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
          url="https://tile.opentopomap.org/{z}/{x}/{y}.png" maxNativeZoom={17} maxZoom={19} />
      </LayersControl.BaseLayer>
      <LayersControl.BaseLayer name="Satellite" checked={cur !== "Street" && cur !== "Terrain"}>
        <TileLayer
          attribution="Imagery &copy; Esri, Maxar, Earthstar Geographics"
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" maxNativeZoom={18} maxZoom={19} />
      </LayersControl.BaseLayer>
    </LayersControl>
  );
}

export function FitTo({ pts }: { pts: LngLat[] | null }) {
  const map = useMap();
  useEffect(() => {
    if (pts && pts.length) map.fitBounds(pts.map(ll), { padding: [30, 30] });
  }, [map, pts]);
  return null;
}

/** Load-and-reload helper with an error line. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let dead = false;
    fn().then((d) => { if (!dead) { setData(d); setErr(""); } }).catch((e) => { if (!dead) setErr(e.message ?? String(e)); });
    return () => { dead = true; };
  }, [...deps, tick]);
  return { data, err, reload: () => setTick((n) => n + 1) };
}

export const Card = ({ title, children, right }: { title?: string; children: ReactNode; right?: ReactNode }) => (
  <section className="card">
    {(title || right) && <div className="row between"><h3>{title}</h3>{right}</div>}
    {children}
  </section>
);

/** Shows a generated password once. It is stored hashed and cannot be shown again. */
export function SecretBox({ label, value, onClose }: { label: string; value: string; onClose: () => void }) {
  return (
    <div className="secret">
      <div className="small">{label}</div>
      <code className="big">{value}</code>
      <div className="row">
        <button className="ghost" onClick={() => void navigator.clipboard?.writeText(value)}>Copy</button>
        <button className="ghost" onClick={onClose}>I saved it, hide</button>
      </div>
      <div className="small muted">Shown once. Give it to the worker; they cannot change it. You can set a new one any time.</div>
    </div>
  );
}
