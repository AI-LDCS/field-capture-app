import { type FormEvent, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertCircle, AlertTriangle, CheckCircle, Close, Info } from "./icons.tsx";

/**
 * Notifications and dialogs for the whole app. Both are small stores, so any code can call them
 * (`toast.error(...)`, `await confirmDialog(...)`); <FeedbackHost /> draws them once, outside the pages.
 */

function store<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const f of subs) f();
    },
    use: () =>
      useSyncExternalStore(
        (f) => {
          subs.add(f);
          return () => subs.delete(f);
        },
        () => value,
      ),
  };
}

// ---------- notifications ----------
type Kind = "success" | "error" | "warning" | "info";
type Toast = { id: number; kind: Kind; text: string; shown: number };

/** Errors stay longest: they may need reading twice, outdoors, on a phone. */
const LIFETIME_MS: Record<Kind, number> = { success: 4000, info: 5000, warning: 8000, error: 12000 };
const MAX_VISIBLE = 4;

const toasts = store<Toast[]>([]);
let nextId = 1;
const dismiss = (id: number) => toasts.set(toasts.get().filter((t) => t.id !== id));

function show(kind: Kind, text: string) {
  const same = toasts.get().find((t) => t.kind === kind && t.text === text);
  // the same message again restarts its timer instead of stacking a copy
  const others = toasts.get().filter((t) => t !== same);
  toasts.set([...others, { id: same?.id ?? nextId++, kind, text, shown: Date.now() }].slice(-MAX_VISIBLE));
}

export const toast = {
  success: (text: string) => show("success", text),
  error: (text: string) => show("error", text),
  warning: (text: string) => show("warning", text),
  info: (text: string) => show("info", text),
};

const ICONS = { success: CheckCircle, error: AlertCircle, warning: AlertTriangle, info: Info };

function ToastCard({ t }: { t: Toast }) {
  const [paused, setPaused] = useState(false);
  const Icon = ICONS[t.kind];
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => dismiss(t.id), LIFETIME_MS[t.kind]);
    return () => clearTimeout(timer);
  }, [paused, t.id, t.kind, t.shown]);
  return (
    <div
      className={`toast toast-${t.kind}`}
      role={t.kind === "error" || t.kind === "warning" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <span className="toast-icon">
        <Icon size={18} />
      </span>
      <span className="toast-text">{t.text}</span>
      <button type="button" className="icon-btn small" aria-label="Dismiss" title="Dismiss" onClick={() => dismiss(t.id)}>
        <Close size={14} />
      </button>
    </div>
  );
}

// ---------- dialogs ----------
/**
 * A modal on the browser's <dialog>: it traps focus, closes on Esc, gives focus back afterwards (see below),
 * and draws above everything, including the recording view. Set `persistent` when closing by accident
 * would lose something. Put data-autofocus on the control that should start with focus.
 */
export function Modal({
  title,
  onClose,
  persistent,
  children,
}: {
  title: string;
  onClose: () => void;
  persistent?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const before = document.activeElement as HTMLElement | null;
    if (!d.open) d.showModal();
    d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      d.close();
      before?.focus(); // React has already removed the dialog, so the browser cannot do this itself
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="modal-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!persistent) onClose();
      }}
    >
      <div className="modal-head">
        <h2 id="modal-title">{title}</h2>
        {!persistent && (
          <button type="button" className="icon-btn" aria-label="Close" title="Close" onClick={onClose}>
            <Close />
          </button>
        )}
      </div>
      {children}
    </dialog>
  );
}

type ConfirmOptions = { title: string; body?: ReactNode; confirmLabel: string; cancelLabel?: string; danger?: boolean };
type PromptOptions = {
  title: string;
  label: string;
  body?: ReactNode;
  initial?: string;
  placeholder?: string;
  confirmLabel: string;
  maxLength?: number;
  allowEmpty?: boolean;
};
type Open =
  | { kind: "confirm"; o: ConfirmOptions; done: (ok: boolean) => void }
  | { kind: "prompt"; o: PromptOptions; done: (value: string | null) => void };

const dialogs = store<Open[]>([]);
const closeDialog = (d: Open) => dialogs.set(dialogs.get().filter((x) => x !== d));

export const confirmDialog = (o: ConfirmOptions) =>
  new Promise<boolean>((resolve) => {
    const d: Open = {
      kind: "confirm",
      o,
      done: (ok) => {
        closeDialog(d);
        resolve(ok);
      },
    };
    dialogs.set([...dialogs.get(), d]);
  });

/** Resolves with the trimmed text, or null if cancelled. */
export const promptDialog = (o: PromptOptions) =>
  new Promise<string | null>((resolve) => {
    const d: Open = {
      kind: "prompt",
      o,
      done: (value) => {
        closeDialog(d);
        resolve(value);
      },
    };
    dialogs.set([...dialogs.get(), d]);
  });

function ConfirmBox({ o, done }: { o: ConfirmOptions; done: (ok: boolean) => void }) {
  return (
    <Modal title={o.title} onClose={() => done(false)}>
      {o.body && <div className="modal-body">{o.body}</div>}
      <div className="modal-actions">
        {/* A destructive choice must be a deliberate one, so focus starts on Cancel. */}
        <button type="button" className="ghost" data-autofocus={o.danger ? "" : undefined} onClick={() => done(false)}>
          {o.cancelLabel ?? "Cancel"}
        </button>
        <button type="button" className={o.danger ? "danger" : ""} data-autofocus={o.danger ? undefined : ""} onClick={() => done(true)}>
          {o.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

function PromptBox({ o, done }: { o: PromptOptions; done: (value: string | null) => void }) {
  const [value, setValue] = useState(o.initial ?? "");
  const empty = !o.allowEmpty && !value.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!empty) done(value.trim());
  };
  return (
    <Modal title={o.title} onClose={() => done(null)}>
      <form onSubmit={submit}>
        <div className="modal-body">
          {o.body && <p>{o.body}</p>}
          <label>
            {o.label}
            <input
              data-autofocus=""
              value={value}
              placeholder={o.placeholder}
              maxLength={o.maxLength}
              autoComplete="off"
              onChange={(e) => setValue(e.target.value)}
              onFocus={(e) => e.target.select()}
            />
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={() => done(null)}>
            Cancel
          </button>
          <button type="submit" disabled={empty}>
            {o.confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Rendered once, beside the app, so it also works on the sign-in page. */
export function FeedbackHost() {
  const openDialogs = dialogs.use();
  const list = toasts.use();
  return (
    <>
      <div className="toasts" aria-live="polite">
        {list.map((t) => (
          <ToastCard key={t.id} t={t} />
        ))}
      </div>
      {openDialogs.map((d, i) =>
        d.kind === "confirm" ? <ConfirmBox key={i} o={d.o} done={d.done} /> : <PromptBox key={i} o={d.o} done={d.done} />,
      )}
    </>
  );
}
