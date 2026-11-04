import { densify, haversineM } from "@shared/geo.ts";
import type { LngLat } from "@shared/types.ts";
import { getSettings } from "./settings.ts";

export type Fix = { t: number; lat: number; lng: number; acc: number };
export type GpsSource = {
  subscribe(cb: (f: Fix) => void, onError?: (msg: string, denied: boolean) => void): () => void;
};

export const realGps: GpsSource = {
  subscribe(cb, onError) {
    if (!navigator.geolocation) {
      onError?.("Geolocation not supported", true);
      return () => {};
    }
    const id = navigator.geolocation.watchPosition(
      (p) => cb({ t: p.timestamp, lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      (e) => onError?.(e.message || `error ${e.code}`, e.code === e.PERMISSION_DENIED),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  },
};

/** Dev-only: 1 Hz fixes that start inaccurate, then walk the drawn route. */
class FakeGps implements GpsSource {
  private subs = new Set<(f: Fix) => void>();
  private timer: number | null = null;
  private pos: LngLat = [100.5018, 13.7563];
  private path: LngLat[] = [];
  private bornAt = Date.now();
  walking = false;

  setStart(p: LngLat) {
    if (this.path.length === 0 && !this.walking) this.pos = p;
  }
  coldStart() {
    this.bornAt = Date.now();
  }

  /** Walk straight from the current spot onto each segment in turn. Skipped parts become a connector line. */
  walk(segments: LngLat[][]) {
    const pts: LngLat[] = [];
    let at = this.pos;
    for (const seg of segments) {
      pts.push(...densify([at, seg[0]], 5), ...densify(seg, 5));
      at = seg[seg.length - 1];
    }
    this.path = pts;
    this.walking = true;
  }
  stopWalking() {
    this.path = [];
    this.walking = false;
  }

  private tick = () => {
    const speed = getSettings().fakeSpeed;
    if (this.path.length) {
      let budget = speed;
      while (budget > 0 && this.path.length) {
        const next = this.path[0];
        const d = haversineM(this.pos, next);
        if (d <= budget) {
          this.pos = next;
          this.path.shift();
          budget -= d;
        } else {
          const f = budget / d;
          this.pos = [this.pos[0] + (next[0] - this.pos[0]) * f, this.pos[1] + (next[1] - this.pos[1]) * f];
          budget = 0;
        }
      }
      if (!this.path.length) this.walking = false;
    }
    const warm = (Date.now() - this.bornAt) / 1000 >= getSettings().coldStartS;
    const acc = warm ? 5 + Math.random() * 4 : 30 + Math.random() * 25;
    const jitter = warm ? 1.5 : 12; // metres
    const lat = this.pos[1] + ((Math.random() - 0.5) * 2 * jitter) / 111_000;
    const lng = this.pos[0] + ((Math.random() - 0.5) * 2 * jitter) / (111_000 * Math.cos((this.pos[1] * Math.PI) / 180));
    const fix = { t: Date.now(), lat, lng, acc };
    this.subs.forEach((f) => f(fix));
  };

  subscribe(cb: (f: Fix) => void) {
    this.subs.add(cb);
    this.timer ??= window.setInterval(this.tick, 1000);
    return () => {
      this.subs.delete(cb);
      if (!this.subs.size && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }
}
export const fakeGps = new FakeGps();
export const gpsSource = (): GpsSource => (getSettings().fake ? fakeGps : realGps);
