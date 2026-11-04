import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "./icons.tsx";

export type ThemeChoice = "light" | "dark" | "system";

const KEY = "fc-theme"; // web/public/theme-init.js reads the same key before the page paints
const HEADER = { light: "#1d4ed8", dark: "#1b1f25" };
const osDark = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

let choice = read();

function apply() {
  const mode = choice === "system" ? (osDark.matches ? "dark" : "light") : choice;
  document.documentElement.dataset.theme = mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", HEADER[mode]);
}

export function setTheme(next: ThemeChoice) {
  choice = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* still applies until the page is closed */
  }
  apply();
  for (const f of listeners) f();
}

osDark.addEventListener("change", apply); // only changes anything while the choice is System
addEventListener("storage", (e) => {
  if (e.key !== KEY) return;
  choice = read();
  apply();
  for (const f of listeners) f();
});
apply();

const OPTIONS = [
  { value: "light", label: "Light theme", Icon: Sun },
  { value: "dark", label: "Dark theme", Icon: Moon },
  { value: "system", label: "Use system theme", Icon: Monitor },
] as const;

export function ThemeSwitcher() {
  const current = useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => choice,
  );
  return (
    <fieldset className="theme-switch">
      <legend className="sr-only">Theme</legend>
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          className={current === value ? "on" : ""}
          aria-label={label}
          aria-pressed={current === value}
          title={label}
          onClick={() => setTheme(value)}
        >
          <Icon />
        </button>
      ))}
    </fieldset>
  );
}
