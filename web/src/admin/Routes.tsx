import { useState } from "react";
import { api } from "../api.ts";
import { Badge, Card, km, useLoad, when } from "../ui.tsx";

const deleteRouteText = (r: { name: string; versions: { status: string; assignmentCount: number }[] }) => {
  const used = r.versions.reduce((n, v) => n + v.assignmentCount, 0);
  return used
    ? `Delete the route "${r.name}"?\n\nIt is removed from this list and cannot be assigned again. Its ${used} assignment${used === 1 ? "" : "s"}, recordings and video are kept (shown as "(deleted)"), and workers can finish what they already have. This cannot be undone.`
    : `Delete the route "${r.name}"? It has no assignments. This cannot be undone.`;
};

export function RoutesPage() {
  const { data, err, reload } = useLoad(() => api.routes());
  const [msg, setMsg] = useState("");
  const act = async (fn: () => Promise<unknown>, then?: () => void) => {
    setMsg("");
    try {
      await fn();
      reload();
      then?.();
    } catch (x: any) {
      setMsg(x.message);
    }
  };

  return (
    <>
      <Card
        title="Routes"
        right={
          <a className="btn" href="#/routes/new">
            + New route
          </a>
        }
      >
        <p className="muted small">
          A published version never changes, except its name. To change a route, make a new version; existing assignments keep the version
          they were given.
        </p>
        {err && <p className="err">{err}</p>}
        {msg && <p className="err">{msg}</p>}
        {data?.length === 0 && <p className="muted">No routes yet.</p>}
      </Card>
      {data?.map((r) => {
        const hasDraft = r.versions.some((v) => v.status === "draft");
        return (
          <Card
            key={r.id}
            title={r.name}
            right={
              <div className="row wrap">
                <button
                  className="ghost"
                  onClick={() => {
                    const n = prompt("Route name (changes it everywhere, including existing assignments)", r.name);
                    if (n !== null && n.trim() !== r.name) void act(() => api.renameRoute(r.id, n));
                  }}
                >
                  Rename
                </button>
                {!hasDraft && (
                  <button
                    className="ghost"
                    onClick={() =>
                      void act(async () => {
                        const v = await api.newVersion(r.id);
                        location.hash = `#/routes/edit/${v.id}`;
                      })
                    }
                  >
                    + New version
                  </button>
                )}
                <button className="ghost danger-text" onClick={() => confirm(deleteRouteText(r)) && void act(() => api.deleteRoute(r.id))}>
                  Delete route
                </button>
              </div>
            }
          >
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
                      <a className="btn ghost" href={`#/routes/edit/${v.id}`}>
                        Edit
                      </a>
                      <button className="ghost" onClick={() => void act(() => api.publish(v.id))}>
                        Publish
                      </button>
                      <button
                        className="ghost danger-text"
                        onClick={() => confirm("Delete this draft?") && void act(() => api.deleteDraft(v.id))}
                      >
                        Delete
                      </button>
                    </>
                  ) : (
                    <a className="btn ghost" href={`#/routes/edit/${v.id}`}>
                      View
                    </a>
                  )}
                  {v.status === "published" && (
                    <>
                      <a className="btn" href={`#/assign/${v.id}`}>
                        Assign
                      </a>
                      <button
                        className="ghost"
                        onClick={() =>
                          confirm("Archive this version? No new assignments, existing ones continue.") && void act(() => api.archive(v.id))
                        }
                      >
                        Archive
                      </button>
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
