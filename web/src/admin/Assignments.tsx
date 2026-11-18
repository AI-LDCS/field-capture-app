import { useState, type FormEvent } from "react";
import type { AssignmentPurpose } from "@shared/types.ts";
import { api } from "../api.ts";
import { confirmDialog, toast } from "../feedback.tsx";
import { Badge, Card, useLoad, when } from "../ui.tsx";

export function Assignments({ presetVersionId }: { presetVersionId?: string }) {
  const [status, setStatus] = useState("");
  const [workerFilter, setWorkerFilter] = useState("");
  const list = useLoad(() => api.assignments({ status, userId: workerFilter }), [status, workerFilter]);
  const workers = useLoad(() => api.workers());
  const routes = useLoad(() => api.routes());

  const [versionId, setVersionId] = useState(presetVersionId ?? "");
  const [userId, setUserId] = useState("");
  const [purpose, setPurpose] = useState<AssignmentPurpose>("inference");

  const published = (routes.data ?? []).flatMap((r) =>
    r.versions.filter((v) => v.status === "published").map((v) => ({ id: v.id, label: `${r.name} · v${v.version}` })),
  );
  const active = (workers.data ?? []).filter((w) => w.active);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.createAssignment(versionId, userId, purpose);
      toast.success("Route assigned");
      list.reload();
    } catch (x: any) {
      toast.error(x.message);
    }
  };

  return (
    <>
      <Card title="Assign a route">
        <form onSubmit={create} className="grid2">
          <label>
            Route (published versions)
            <select value={versionId} onChange={(e) => setVersionId(e.target.value)}>
              <option value="">Choose…</option>
              {published.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Field worker
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose…</option>
              {active.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.username}
                  {w.displayName ? ` (${w.displayName})` : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            What the images are for
            <select value={purpose} onChange={(e) => setPurpose(e.target.value as AssignmentPurpose)}>
              <option value="inference">Scoring (inference): only admins download the images</option>
              <option value="training">Training: the worker downloads the images to label them</option>
            </select>
          </label>
          <div className="row">
            <button disabled={!versionId || !userId}>Assign</button>
          </div>
        </form>
        {published.length === 0 && routes.data && <p className="muted small">Nothing to assign yet: publish a route first.</p>}
      </Card>

      <Card title="Assignments">
        <div className="grid2">
          <label>
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {["assigned", "in_progress", "pending_sync", "completed", "needs_review"].map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
          <label>
            Worker
            <select value={workerFilter} onChange={(e) => setWorkerFilter(e.target.value)}>
              <option value="">All</option>
              {(workers.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.username}
                </option>
              ))}
            </select>
          </label>
        </div>
        {list.err && <p className="err">{list.err}</p>}
        {list.data?.length === 0 && <p className="muted">No assignments.</p>}
        {list.data?.map((a) => (
          <div key={a.id} className="item row between">
            <div>
              <strong>{a.route.name}</strong>
              {a.route.deleted && <span className="muted"> (deleted)</span>} <span className="muted">v{a.route.version}</span>{" "}
              <Badge s={a.status} /> <span className="small muted">{a.purpose === "training" ? "training" : "scoring"}</span>
              <div className="small muted">
                {a.worker.username}
                {a.worker.deleted && " (deleted)"} · required {a.progress.requiredDone}/{a.progress.requiredTotal} · {when(a.createdAt)}
              </div>
            </div>
            <div className="row">
              <a className="btn ghost" href={`#/assignment/${a.id}`}>
                Open
              </a>
              {a.status === "assigned" && (
                <button
                  className="ghost danger-text"
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: "Withdraw this assignment?",
                      body: `${a.route.name} is taken back from ${a.worker.username}.`,
                      confirmLabel: "Withdraw",
                      danger: true,
                    });
                    if (!ok) return;
                    try {
                      await api.withdrawAssignment(a.id);
                      toast.success("Assignment withdrawn");
                      list.reload();
                    } catch (x: any) {
                      toast.error(x.message);
                    }
                  }}
                >
                  Withdraw
                </button>
              )}
            </div>
          </div>
        ))}
      </Card>
    </>
  );
}
