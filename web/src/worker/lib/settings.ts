import { useSyncExternalStore } from "react";

export type Settings = {
  fake: boolean; // fake GPS + canvas camera (dev tools only)
  fakeSpeed: number; // m/s
  coldStartS: number; // fake GPS warm-up before it becomes accurate (999 = never)
  preflightTimeoutS: number;
  simOffline: boolean; // uploader pretends there is no network (dev tools only)
};
const KEY = "fc-settings";
const defaults: Settings = { fake: false, fakeSpeed: 10, coldStartS: 8, preflightTimeoutS: 90, simOffline: false };

let raw: Settings = defaults;
try {
  raw = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
} catch {
  /* ignore */
}
let devTools = false;
const subs = new Set<() => void>();

// What the code sees: fake mode and simulated offline exist only while the server says dev tools are on.
let eff: Settings = raw;
const recompute = () => {
  eff = { ...raw, fake: raw.fake && devTools, simOffline: raw.simOffline && devTools };
  subs.forEach((f) => f());
};

export const getSettings = () => eff;
export const getRawSettings = () => raw;
export function setSettings(patch: Partial<Settings>) {
  raw = { ...raw, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(raw));
  } catch {
    /* ignore */
  }
  recompute();
}
export function setDevTools(on: boolean) {
  if (on !== devTools) {
    devTools = on;
    recompute();
  }
}
export const devToolsOn = () => devTools;
export const useSettings = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), getSettings);
