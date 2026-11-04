import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LayersControl, TileLayer, useMap, useMapEvents } from "react-leaflet";
import type { LngLat } from "@shared/types.ts";
import { Modal } from "./feedback.tsx";
import { More } from "./icons.tsx";

export const Badge = ({ s }: { s: string }) => <span className={`badge b-${s}`}>{s.replace(/_/g, " ")}</span>;

export const fmtBytes = (n: number) =>
  n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;

export const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");
export const ll = (c: LngLat): [number, number] => [c[1], c[0]];

const LAYER_KEY = "fc-map-layer";
const saved = () => {
  try {
    return localStorage.getItem(LAYER_KEY) ?? "Satellite";
  } catch {
    return "Satellite";
  }
};

/** Street, terrain or satellite base map; satellite by default; the choice is remembered. */
export function Tiles() {
  useMapEvents({
    baselayerchange: (e) => {
      try {
        localStorage.setItem(LAYER_KEY, e.name);
      } catch {
        /* ignore */
      }
    },
  });
  const cur = saved();
  return (
    <LayersControl position="topright">
      <LayersControl.BaseLayer name="Street" checked={cur === "Street"}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
        />
      </LayersControl.BaseLayer>
      <LayersControl.BaseLayer name="Terrain" checked={cur === "Terrain"}>
        <TileLayer
          attribution='Map data &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>, SRTM | Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
          url="https://tile.opentopomap.org/{z}/{x}/{y}.png"
          maxNativeZoom={17}
          maxZoom={19}
        />
      </LayersControl.BaseLayer>
      <LayersControl.BaseLayer name="Satellite" checked={cur !== "Street" && cur !== "Terrain"}>
        <TileLayer
          attribution="Imagery &copy; Esri, Maxar, Earthstar Geographics"
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          maxNativeZoom={18}
          maxZoom={19}
        />
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
    fn()
      .then((d) => {
        if (!dead) {
          setData(d);
          setErr("");
        }
      })
      .catch((e) => {
        if (!dead) setErr(e.message ?? String(e));
      });
    return () => {
      dead = true;
    };
  }, [...deps, tick]);
  return { data, err, reload: () => setTick((n) => n + 1) };
}

export const Card = ({ title, children, right }: { title?: string; children: ReactNode; right?: ReactNode }) => (
  <section className="card">
    {(title || right) && (
      <div className="row between">
        <h3>{title}</h3>
        {right}
      </div>
    )}
    {children}
  </section>
);

/** Shows a generated password once. It is stored hashed and cannot be shown again, so only the button closes this. */
export function SecretModal({ label, value, onClose }: { label: string; value: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => setCopied(true));
  };
  return (
    <Modal title={label} persistent onClose={onClose}>
      <div className="modal-body">
        <div className="secret">
          <code className="big">{value}</code>
        </div>
        <p className="small muted row">Shown once. Give it to the worker; they cannot change it. You can set a new one any time.</p>
      </div>
      <div className="modal-actions">
        <button type="button" className="ghost" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" data-autofocus="" onClick={onClose}>
          I saved it
        </button>
      </div>
    </Modal>
  );
}

/** A small dropdown of actions, so a row shows only its main one. */
export function Menu({ label, items }: { label: string; items: { label: string; onClick: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const entries = () => [...(root.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];

  useEffect(() => {
    if (!open) return;
    entries()[0]?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("pointerdown", outside);
    return () => removeEventListener("pointerdown", outside);
  }, [open]);

  const keys = (e: KeyboardEvent) => {
    const all = entries();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      all[(at + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
    } else if (e.key === "Tab") setOpen(false);
  };

  return (
    <div className="menu" ref={root} onKeyDown={open ? keys : undefined}>
      <button
        ref={trigger}
        type="button"
        className="ghost icon-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <More />
      </button>
      {open && (
        <div className="menu-list" role="menu" aria-label={label}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={it.danger ? "danger-item" : ""}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
                it.onClick();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
