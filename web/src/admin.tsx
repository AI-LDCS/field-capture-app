import { useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { Badge, Card, SecretBox, km, useLoad, when } from "./ui.tsx";

// ---------- workers ----------
export function Workers() {
  const { data, err, reload } = useLoad(() => api.workers());
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [msg, setMsg] = useState("");

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setMsg("");
    try {
      const r = await api.createWorker(username, displayName);
      setSecret({ label: `Temporary password for ${r.user.username}`, value: r.temporaryPassword });
      setUsername(""); setDisplayName("");
      reload();
    } catch (x: any) { setMsg(x.message); }
  };
  const act = async (fn: () => Promise<unknown>) => {
    setMsg("");
    try { await fn(); reload(); } catch (x: any) { setMsg(x.message); }
  };

  return (
    <>
      <Card title="Add a field worker">
        <form onSubmit={create} className="grid2">
          <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. somchai" autoCapitalize="none" /></label>
          <label>Name (optional)<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></label>
          <div className="row"><button disabled={!username}>Create worker</button></div>
        </form>
        <p className="muted small">A temporary password is generated and shown once.</p>
        {msg && <p className="err">{msg}</p>}
        {secret && <SecretBox {...secret} onClose={() => setSecret(null)} />}
      </Card>

      <Card title="Field workers">
        {err && <p className="err">{err}</p>}
        {data?.length === 0 && <p className="muted">No workers yet.</p>}
        {data?.map((w) => (
          <div key={w.id} className="item">
            <div className="row between">
              <div>
                <strong>{w.username}</strong> {w.displayName && <span className="muted">· {w.displayName}</span>}{" "}
                {!w.active && <Badge s="deactivated" />} {w.mustChangePassword && <Badge s="temp password" />}
                <div className="small muted">last active {when(w.lastActiveAt)}</div>
              </div>
              <div className="row wrap">
                <button className="ghost" onClick={() => {
                  const n = prompt("Display name", w.displayName);
                  if (n !== null) void act(() => api.renameWorker(w.id, n));
                }}>Rename</button>
                <button className="ghost" onClick={() => confirm(`Reset the password of ${w.username}? They will be signed out everywhere.`) &&
                  void act(async () => { const r = await api.resetPassword(w.id); setSecret({ label: `New temporary password for ${w.username}`, value: r.temporaryPassword }); })}>
                  Reset password
                </button>
                {w.active
                  ? <button className="ghost danger-text" onClick={() => confirm(`Deactivate ${w.username}? They are signed out immediately.`) && void act(() => api.setWorkerActive(w.id, false))}>Deactivate</button>
                  : <button className="ghost" onClick={() => void act(() => api.setWorkerActive(w.id, true))}>Reactivate</button>}
              </div>
            </div>
          </div>
        ))}
      </Card>
    </>
  );
}

// ---------- routes ----------
export function RoutesPage() {
  const { data, err, reload } = useLoad(() => api.routes());
  const [msg, setMsg] = useState("");
  const act = async (fn: () => Promise<unknown>, then?: () => void) => {
    setMsg("");
    try { await fn(); reload(); then?.(); } catch (x: any) { setMsg(x.message); }
  };

  return (
    <>
      <Card title="Routes" right={<a className="btn" href="#/routes/new">+ New route</a>}>
        <p className="muted small">A published version never changes. To change a route, make a new version; existing assignments keep the version they were given.</p>
        {err && <p className="err">{err}</p>}
        {msg && <p className="err">{msg}</p>}
        {data?.length === 0 && <p className="muted">No routes yet.</p>}
      </Card>
      {data?.map((r) => {
        const hasDraft = r.versions.some((v) => v.status === "draft");
        return (
          <Card key={r.id} title={r.name}
            right={!hasDraft && <button className="ghost" onClick={() => void act(async () => { const v = await api.newVersion(r.id); location.hash = `#/routes/edit/${v.id}`; })}>+ New version</button>}>
            {r.versions.map((v) => (
              <div key={v.id} className="item row between">
                <div>
                  v{v.version} <Badge s={v.status} />
                  <div className="small muted">
                    {v.segmentCount} segments · {km(v.lengthM)} · {v.assignmentCount} assignment{v.assignmentCount === 1 ? "" : "s"}
                    {v.publishedAt && <> · published {when(v.publishedAt)}</>}
                  </div>
                </div>
                <div className="row wrap">
                  {v.status === "draft" ? (
                    <>
                      <a className="btn ghost" href={`#/routes/edit/${v.id}`}>Edit</a>
                      <button className="ghost" onClick={() => void act(() => api.publish(v.id))}>Publish</button>
                      <button className="ghost danger-text" onClick={() => confirm("Delete this draft?") && void act(() => api.deleteDraft(v.id))}>Delete</button>
                    </>
                  ) : (
                    <a className="btn ghost" href={`#/routes/edit/${v.id}`}>View</a>
                  )}
                  {v.status === "published" && (
                    <>
                      <a className="btn" href={`#/assign/${v.id}`}>Assign</a>
                      <button className="ghost" onClick={() => confirm("Archive this version? No new assignments, existing ones continue.") && void act(() => api.archive(v.id))}>Archive</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </Card>
        );
      })}
    </>
  );
}

// ---------- assignments ----------
export function Assignments({ presetVersionId }: { presetVersionId?: string }) {
  const [status, setStatus] = useState("");
  const [workerFilter, setWorkerFilter] = useState("");
  const list = useLoad(() => api.assignments({ status, userId: workerFilter }), [status, workerFilter]);
  const workers = useLoad(() => api.workers());
  const routes = useLoad(() => api.routes());

  const [versionId, setVersionId] = useState(presetVersionId ?? "");
  const [userId, setUserId] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");

  const published = (routes.data ?? []).flatMap((r) => r.versions.filter((v) => v.status === "published").map((v) => ({ id: v.id, label: `${r.name} · v${v.version}` })));
  const active = (workers.data ?? []).filter((w) => w.active);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setMsg("");
    try {
      await api.createAssignment(versionId, userId, note);
      setNote("");
      list.reload();
    } catch (x: any) { setMsg(x.message); }
  };

  return (
    <>
      <Card title="Assign a route">
        <form onSubmit={create} className="grid2">
          <label>Route (published versions)
            <select value={versionId} onChange={(e) => setVersionId(e.target.value)}>
              <option value="">Choose…</option>
              {published.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <label>Field worker
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose…</option>
              {active.map((w) => <option key={w.id} value={w.id}>{w.username}{w.displayName ? ` (${w.displayName})` : ""}</option>)}
            </select>
          </label>
          <label>Note (optional)<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <div className="row"><button disabled={!versionId || !userId}>Assign</button></div>
        </form>
        {msg && <p className="err">{msg}</p>}
        {published.length === 0 && routes.data && <p className="muted small">Nothing to assign yet: publish a route first.</p>}
      </Card>

      <Card title="Assignments">
        <div className="grid2">
          <label>Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {["assigned", "in_progress", "pending_sync", "completed", "needs_review"].map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
            </select>
          </label>
          <label>Worker
            <select value={workerFilter} onChange={(e) => setWorkerFilter(e.target.value)}>
              <option value="">All</option>
              {(workers.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.username}</option>)}
            </select>
          </label>
        </div>
        {list.err && <p className="err">{list.err}</p>}
        {list.data?.length === 0 && <p className="muted">No assignments.</p>}
        {list.data?.map((a) => (
          <div key={a.id} className="item row between">
            <div>
              <strong>{a.route.name}</strong> <span className="muted">v{a.route.version}</span> <Badge s={a.status} />
              <div className="small muted">
                {a.worker.username} · required {a.progress.requiredDone}/{a.progress.requiredTotal} · {when(a.createdAt)}{a.note && <> · “{a.note}”</>}
              </div>
            </div>
            <div className="row">
              <a className="btn ghost" href={`#/assignment/${a.id}`}>Open</a>
              {a.status === "assigned" && (
                <button className="ghost danger-text" onClick={() => confirm("Withdraw this assignment?") && api.withdrawAssignment(a.id).then(list.reload).catch((x) => setMsg(x.message))}>Withdraw</button>
              )}
            </div>
          </div>
        ))}
      </Card>
    </>
  );
}
