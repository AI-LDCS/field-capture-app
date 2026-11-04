import { useEffect, useMemo, useRef, useState } from "react";
import type { LngLat, RouteVersion } from "@shared/types.ts";
import { ApiError, api } from "../../api.ts";
import { confirmDialog, toast } from "../../feedback.tsx";
import { Magnet, Pencil, Plus, Redo, Undo } from "../../icons.tsx";
import EditorMap from "./EditorMap.tsx";
import {
  commit,
  hist,
  incompleteSegments,
  insertPoint,
  joinWithNext,
  makeSeg,
  midAfter,
  moveSeg,
  parsePoints,
  redo,
  removePoint,
  removeSeg,
  reverseSeg,
  setPoint,
  splitAt,
  toInput,
  totalLength,
  undo,
  updateSeg,
  type History,
  type Seg,
} from "./model.ts";
import PointsTable from "./PointsTable.tsx";
import SegmentList from "./SegmentList.tsx";
import { Badge, Card, km, useLoad } from "../../ui.tsx";

export function NewRoute() {
  return <Editor />;
}
export function EditVersion({ versionId }: { versionId: string }) {
  const { data, err } = useLoad(() => api.version(versionId), [versionId]);
  if (err) return <p className="err">{err}</p>;
  if (!data) return <p>Loading…</p>;
  return <Editor version={data} />;
}

/** Save this long after the last edit, or at the latest this long after the first one, even if edits never pause. */
const AUTOSAVE_MS = 2000;
const AUTOSAVE_MAX_WAIT_MS = 15_000;
const RETRY_MS = 5000;
/** The name of a route nobody has named yet, so drawing can be saved from the first segment. It cannot be published. */
const UNTITLED = "Untitled route";
const snapshot = (n: string, s: Seg[]) => JSON.stringify([n.trim() || UNTITLED, toInput(s)]);

const SNAP_KEY = "fc-editor-snap";
/** On unless this browser turned it off. */
const loadSnap = () => {
  try {
    return localStorage.getItem(SNAP_KEY) !== "off";
  } catch {
    return true;
  }
};

const fromVersion = (v?: RouteVersion): Seg[] =>
  (v?.segments ?? []).map((s) =>
    makeSeg(s.coords, { name: s.name, required: s.required, smooth: s.smooth, minCoverage: s.minCoverageRatio }),
  );

function Editor({ version }: { version?: RouteVersion }) {
  const readOnly = !!version && version.status !== "draft";
  const [name, setName] = useState(version?.routeName ?? "");
  const [h, setH] = useState<History<Seg[]>>(() => hist(fromVersion(version)));
  const segs = h.present;
  const [sel, setSel] = useState<string | null>(null);
  const [selPt, setSelPt] = useState<number | null>(null);
  const [draw, setDraw] = useState(false);
  const [snap, setSnap] = useState(loadSnap);
  const [fit, setFit] = useState<LngLat[] | null>(version ? version.segments.flatMap((s) => s.coords) : null);
  const [center, setCenter] = useState<LngLat>([100.5018, 13.7563]);
  const [bulk, setBulk] = useState("");
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [vid, setVid] = useState(version?.id);
  const [opened] = useState(() => snapshot(version?.routeName ?? "", fromVersion(version)));
  const [saved, setSaved] = useState(opened);
  const dirty = !readOnly && snapshot(name, segs) !== saved;

  // Autosave sends the segments that are finished. One still being drawn joins the next save, once it has two points.
  const complete = useMemo(() => segs.filter((s) => s.coords.length >= 2), [segs]);
  const saveable = snapshot(name, complete);
  const pending = !readOnly && saveable !== saved;
  const canAutosave = pending && (!!vid || complete.length > 0); // opening New route and leaving creates nothing
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(0);
  const [refused, setRefused] = useState<{ payload: string; message: string } | null>(null); // the server said no: wait for the next edit
  const isRefused = refused?.payload === saveable;

  // One save at a time, in order, so two saves cannot both create the route and an older one cannot land last.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const vidNow = useRef(version?.id);
  const persist = (n: string, s: Seg[]) => {
    const run = queue.current.then(async () => {
      const routeName = n.trim() || UNTITLED;
      if (vidNow.current) await api.saveDraft(vidNow.current, routeName, toInput(s));
      else {
        vidNow.current = (await api.createRoute(routeName, toInput(s))).id;
        // a reload opens this draft. Not a hash change, which would rebuild the editor and lose the undo history.
        if (location.hash === "#/routes/new") history.replaceState(null, "", `#/routes/edit/${vidNow.current}`);
      }
      setVid(vidNow.current);
      setSaved(snapshot(n, s));
      return vidNow.current;
    });
    queue.current = run.catch(() => {});
    return run;
  };

  const edit = (next: Seg[]) => setH((x) => commit(x, next));
  const selSeg = segs.find((s) => s.key === sel) ?? null;

  // start near the admin on a brand-new route
  useEffect(() => {
    if (version) return;
    navigator.geolocation?.getCurrentPosition(
      (p) => {
        const c: LngLat = [p.coords.longitude, p.coords.latitude];
        setCenter(c);
        setFit([c, c]);
      },
      () => {},
      { timeout: 4000 },
    );
  }, []);

  const pendingSince = useRef<number | null>(null);
  useEffect(() => {
    if (!canAutosave) pendingSince.current = null;
    if (!canAutosave || busy || isRefused) return;
    pendingSince.current ??= Date.now();
    const wait = retrying ? RETRY_MS : Math.min(AUTOSAVE_MS, Math.max(0, pendingSince.current + AUTOSAVE_MAX_WAIT_MS - Date.now()));
    const t = setTimeout(async () => {
      setSaving(true);
      try {
        await persist(name, complete);
        pendingSince.current = null;
        setRetrying(0);
        setRefused(null);
      } catch (x: any) {
        // the server refused this content, so sending it again cannot help; anything else may be the network
        if (x instanceof ApiError && x.status >= 400 && x.status < 500) {
          setRetrying(0);
          setRefused({ payload: saveable, message: x.message });
        } else setRetrying((r) => r + 1);
      } finally {
        setSaving(false);
      }
    }, wait);
    return () => clearTimeout(t);
  }, [saveable, canAutosave, busy, isRefused, retrying]);

  // leaving the page inside the wait still saves the last edit
  const published = useRef(false);
  const latest = useRef({ canAutosave, name, complete });
  latest.current = { canAutosave, name, complete };
  useEffect(
    () => () => {
      const l = latest.current;
      if (l.canAutosave && !published.current) void persist(l.name, l.complete).catch(() => {});
    },
    [],
  );

  // leaving with unsaved edits asks first
  useEffect(() => {
    if (!dirty) return;
    const f = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", f);
    return () => removeEventListener("beforeunload", f);
  }, [dirty]);

  // keyboard: Esc stops drawing, Delete removes the picked point, Ctrl/Cmd+Z / Shift+Z undo / redo
  useEffect(() => {
    if (readOnly) return;
    const f = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? "");
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        setH((x) => (e.shiftKey ? redo(x) : undo(x)));
      } else if (mod && e.key.toLowerCase() === "y" && !typing) {
        e.preventDefault();
        setH(redo);
      } else if (e.key === "Escape") setDraw(false);
      else if ((e.key === "Delete" || e.key === "Backspace") && !typing && sel && selPt !== null) {
        e.preventDefault();
        edit(removePoint(segs, sel, selPt));
        setSelPt(null);
      }
    };
    addEventListener("keydown", f);
    return () => removeEventListener("keydown", f);
  });

  const pick = (key: string | null) => {
    setSel(key);
    setSelPt(null);
    if (!key) setDraw(false);
  };

  const toggleSnap = () => {
    const next = !snap;
    setSnap(next);
    try {
      localStorage.setItem(SNAP_KEY, next ? "on" : "off");
    } catch {
      /* it just is not remembered */
    }
  };

  const newSegment = () => {
    const s = makeSeg([], { smooth: true }); // sidewalks bend: curved is the default for hand-drawn segments
    edit([...segs, s]);
    setSel(s.key);
    setSelPt(null);
    setDraw(true);
  };
  const addPoint = (p: LngLat) => {
    if (!sel) return;
    const at = segs.find((s) => s.key === sel)?.coords.length ?? 0;
    edit(insertPoint(segs, sel, at, p));
    setSelPt(at);
  };
  const split = (i: number) => {
    if (!sel) return;
    const r = splitAt(segs, sel, i);
    if (r.newKey) {
      edit(r.segs);
      setSelPt(null);
    }
  };
  const importBulk = () => {
    const { segs: added, errors } = parsePoints(bulk);
    setBulkErrors(errors.length || added.length ? errors : ["no points found"]);
    if (errors.length || !added.length) return;
    edit([...segs, ...added]);
    setFit(added.flatMap((x) => x.coords));
    setSel(added[0].key);
    setBulk("");
  };
  const sample = () => {
    const dLng = 300 / (111_320 * Math.cos((center[1] * Math.PI) / 180));
    const mk = (i: number): LngLat[] => [
      [center[0] + dLng * i, center[1]],
      [center[0] + dLng * (i + 0.5), center[1] + 0.0008],
      [center[0] + dLng * (i + 1), center[1]],
    ];
    const next = [makeSeg(mk(0), { smooth: true }), makeSeg(mk(1), { required: false, smooth: true }), makeSeg(mk(2), { smooth: true })];
    edit(next);
    setFit(next.flatMap((s) => s.coords));
    if (!name) setName("Sample route");
  };

  const save = async (): Promise<string | null> => {
    const bad = incompleteSegments(segs);
    if (bad.length) {
      toast.error(`Segment ${bad.join(", ")} needs at least 2 points (or delete it)`);
      setSel(segs[bad[0] - 1].key);
      return null;
    }
    setBusy(true);
    try {
      const id = await persist(name, segs);
      setRefused(null);
      setRetrying(0);
      return id ?? null;
    } catch (x: any) {
      toast.error(x.message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const saveDraft = async () => {
    if (await save()) toast.success("Draft saved");
  };
  const savePublish = async () => {
    if (!name.trim() || name.trim() === UNTITLED) {
      toast.error("Give the route a name");
      return;
    }
    const id = await save();
    if (!id) return;
    published.current = true;
    try {
      await api.publish(id);
      toast.success("Route published");
      location.hash = "#/routes";
    } catch (x: any) {
      published.current = false;
      toast.error(x.message);
    }
  };

  // Close waits for the save, so the Routes page lists what was just drawn.
  const close = async () => {
    let safe = complete.length === segs.length && !isRefused;
    try {
      if (canAutosave) await persist(name, complete);
      await queue.current;
    } catch {
      safe = false;
    }
    if (!safe) {
      const leave = await confirmDialog({
        title: "Leave with unsaved changes?",
        body: "Some changes could not be saved, or a segment has fewer than 2 points. They are lost if you leave.",
        confirmLabel: "Leave",
        cancelLabel: "Keep editing",
        danger: true,
      });
      if (!leave) return;
    }
    location.hash = "#/routes";
  };

  const revert = async () => {
    const ok = await confirmDialog({
      title: "Go back to how it was when you opened it?",
      body: "This replaces the saved draft too. Undo brings your changes back while this page stays open.",
      confirmLabel: "Revert",
      cancelLabel: "Keep editing",
      danger: true,
    });
    if (!ok) return;
    edit(fromVersion(version));
    if (version) setName(version.routeName);
    setSel(null);
    setSelPt(null);
    setDraw(false);
  };

  const total = useMemo(() => totalLength(segs), [segs]);
  const short = incompleteSegments(segs);
  const status = saving
    ? "Saving…"
    : isRefused
      ? "Not saved"
      : retrying && pending
        ? "Can't save. Trying again…"
        : short.length
          ? `Segment ${short[0]} needs 2 points to save`
          : pending
            ? "Unsaved"
            : vid
              ? "Saved"
              : "";
  const statusOk = status === "Saved" || status === "Saving…";

  return (
    <div className="editor">
      <div className="ed-map">
        <EditorMap
          segs={segs}
          sel={sel}
          selPt={selPt}
          draw={draw}
          readOnly={readOnly}
          snap={snap}
          fit={fit}
          center={center}
          onSelect={pick}
          onSelectPt={setSelPt}
          onAddPoint={addPoint}
          onMovePoint={(k, i, p) => {
            edit(setPoint(segs, k, i, p));
            setSelPt(i);
          }}
          onInsertMid={(k, at, p) => {
            edit(insertPoint(segs, k, at, p));
            setSelPt(at);
          }}
        />
        {!readOnly && (
          <div className="ed-tools">
            <button onClick={newSegment}>
              <Plus /> New segment
            </button>
            <button
              className={draw ? "on" : "ghost"}
              disabled={!selSeg}
              onClick={() => setDraw(!draw)}
              title="Click the map to add points to the selected segment"
            >
              <Pencil /> Draw
            </button>
            <button
              className={snap ? "on" : "ghost"}
              onClick={toggleSnap}
              aria-pressed={snap}
              title="Snap: the end of a segment sticks to the start of another when you bring them close"
            >
              <Magnet /> Snap
            </button>
            <button className="ghost" disabled={!h.past.length} onClick={() => setH(undo)} title="Undo (Ctrl/Cmd+Z)" aria-label="Undo">
              <Undo />
            </button>
            <button
              className="ghost"
              disabled={!h.future.length}
              onClick={() => setH(redo)}
              title="Redo (Ctrl/Cmd+Shift+Z)"
              aria-label="Redo"
            >
              <Redo />
            </button>
          </div>
        )}
        {draw && selSeg && (
          <div className="ed-hint">Drawing segment {segs.indexOf(selSeg) + 1}: click the map to add points · Esc to stop</div>
        )}
      </div>

      <div className="ed-side">
        <Card
          title={readOnly ? `${version!.routeName} · v${version!.version}` : version ? `Edit draft · v${version.version}` : "New route"}
          right={
            <>
              {!readOnly && status && (
                <span className={statusOk ? "muted small" : "dirty"} role="status">
                  {status}
                </span>
              )}{" "}
              {version && <Badge s={version.status} />}
            </>
          }
        >
          {readOnly ? (
            <p className="muted small">
              This version is {version!.status} and cannot be changed. Make a new version from the Routes page to edit.
            </p>
          ) : (
            <label>
              Route name
              <input value={name} maxLength={120} placeholder={UNTITLED} onChange={(e) => setName(e.target.value)} />
            </label>
          )}
          {isRefused && <p className="err small">{refused.message}</p>}
          <div className="row wrap">
            {!readOnly && (
              <button onClick={() => void saveDraft()} disabled={busy || (!dirty && !!vid)}>
                Save draft
              </button>
            )}
            {!readOnly && (
              <button className="ghost" onClick={() => void savePublish()} disabled={busy}>
                Save &amp; publish
              </button>
            )}
            {!readOnly && snapshot(name, segs) !== opened && (
              <button className="ghost" onClick={() => void revert()}>
                Revert
              </button>
            )}
            {readOnly ? (
              <a className="btn ghost" href="#/routes">
                Back
              </a>
            ) : (
              <button className="ghost" onClick={() => void close()}>
                Close
              </button>
            )}
          </div>
        </Card>

        <Card
          title={`Segments · ${segs.length} · ${km(total)}`}
          right={
            !readOnly &&
            !version &&
            segs.length === 0 && (
              <button className="ghost small" onClick={sample}>
                Insert sample
              </button>
            )
          }
        >
          {!readOnly && (
            <p className="muted small">
              The list order is the walking order. Drag the ⋮⋮ grip to reorder; colours and numbers on the map follow.
            </p>
          )}
          <SegmentList
            segs={segs}
            sel={sel}
            readOnly={readOnly}
            onSelect={pick}
            onMove={(from, to) => edit(moveSeg(segs, from, to))}
            onChange={(k, patch) => edit(updateSeg(segs, k, patch))}
            onRemove={(k) => {
              edit(removeSeg(segs, k));
              pick(null);
            }}
            onReverse={(k) => edit(reverseSeg(segs, k))}
            onJoin={(k) => edit(joinWithNext(segs, k))}
          />
          {!readOnly && (
            <div className="row">
              <button onClick={newSegment}>
                <Plus /> New segment
              </button>
            </div>
          )}
        </Card>

        {!readOnly && selSeg && (
          <Card title={`Points of segment ${segs.indexOf(selSeg) + 1} (${selSeg.coords.length})`}>
            <p className="muted small">
              {selSeg.smooth ? "These points are on the sidewalk; the curve passes through each one. " : ""}Edit the numbers, or drag the
              dots on the map. Click a + on the line to add a point. Select a point and press Delete to remove it.
            </p>
            <PointsTable
              seg={selSeg}
              selPt={selPt}
              onSelectPt={setSelPt}
              onSetPoint={(i, p) => edit(setPoint(segs, selSeg.key, i, p))}
              onInsertAfter={(i) => {
                edit(insertPoint(segs, selSeg.key, i + 1, midAfter(selSeg, i)));
                setSelPt(i + 1);
              }}
              onRemovePoint={(i) => {
                edit(removePoint(segs, selSeg.key, i));
                setSelPt(null);
              }}
              onAddPoint={addPoint}
              onSplit={split}
            />
          </Card>
        )}

        {!readOnly && (
          <Card title="Paste many points">
            <p className="muted small">
              One point per line as <code>lat, lng</code>. A blank line starts a new segment. Put <code>optional</code> on its own line
              before a segment to mark it optional.
            </p>
            <textarea
              rows={5}
              placeholder={"13.7563, 100.5018\n13.7571, 100.5030\n\noptional\n13.7580, 100.5045\n13.7590, 100.5060"}
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
            />
            {bulkErrors.length > 0 && (
              <ul className="err small">
                {bulkErrors.slice(0, 6).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
            <div className="row">
              <button onClick={importBulk} disabled={!bulk.trim()}>
                Add as segments
              </button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
