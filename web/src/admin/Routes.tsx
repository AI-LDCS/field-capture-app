import type { RouteSummary } from "@shared/types.ts";
import { api } from "../api.ts";
import { confirmDialog, promptDialog, toast } from "../feedback.tsx";
import { Plus } from "../icons.tsx";
import { Badge, Card, km, Menu, useLoad, when } from "../ui.tsx";

export function RoutesPage() {
  const { data, err, reload } = useLoad(() => api.routes());
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast.success(done);
      reload();
    } catch (x: any) {
      toast.error(x.message);
    }
  };

  const rename = async (r: RouteSummary) => {
    const name = await promptDialog({
      title: "Rename route",
      label: "Route name",
      body: "This changes the name everywhere, including existing assignments.",
      initial: r.name,
      maxLength: 120,
      confirmLabel: "Rename",
    });
    if (name !== null && name !== r.name) void act(() => api.renameRoute(r.id, name), "Route renamed");
  };
  const removeRoute = async (r: RouteSummary) => {
    const used = r.versions.reduce((n, v) => n + v.assignmentCount, 0);
    const ok = await confirmDialog({
      title: `Delete the route "${r.name}"?`,
      body: used
        ? `It is removed from this list and cannot be assigned again. Its ${used} assignment${used === 1 ? "" : "s"}, recordings and video are kept (shown as "(deleted)"), and workers can finish what they already have. This cannot be undone.`
        : "It has no assignments. This cannot be undone.",
      confirmLabel: "Delete route",
      danger: true,
    });
    if (ok) void act(() => api.deleteRoute(r.id), "Route deleted");
  };
  const removeDraft = async (id: string) => {
    const ok = await confirmDialog({
      title: "Delete this draft?",
      body: "This cannot be undone.",
      confirmLabel: "Delete draft",
      danger: true,
    });
    if (ok) void act(() => api.deleteDraft(id), "Draft deleted");
  };
  const archive = async (id: string) => {
    const ok = await confirmDialog({
      title: "Archive this version?",
      body: "No new assignments can use it. Existing ones continue.",
      confirmLabel: "Archive",
    });
    if (ok) void act(() => api.archive(id), "Version archived");
  };

  return (
    <>
      <Card
        title="Routes"
        right={
          <a className="btn" href="#/routes/new">
            <Plus /> New route
          </a>
        }
      >
        <p className="muted small">
          A published version never changes, except its name. To change a route, make a new version; existing assignments keep the version
          they were given.
        </p>
        {err && <p className="err">{err}</p>}
        {data?.length === 0 && <p className="muted">No routes yet.</p>}
      </Card>
      {data?.map((r) => {
        const hasDraft = r.versions.some((v) => v.status === "draft");
        return (
          <Card
            key={r.id}
            title={r.name}
            right={
              <div className="row nogap">
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
                    <Plus /> New version
                  </button>
                )}
                <Menu
                  label={`More actions for ${r.name}`}
                  items={[
                    { label: "Rename", onClick: () => void rename(r) },
                    { label: "Delete route", danger: true, onClick: () => void removeRoute(r) },
                  ]}
                />
              </div>
            }
          >
            {r.versions.map((v) => (
              <div key={v.id} className="item row between wrap">
                <div>
                  v{v.version} <Badge s={v.status} />
                  <div className="small muted">
                    {v.segmentCount} segments · {km(v.lengthM)} · {v.assignmentCount} assignment{v.assignmentCount === 1 ? "" : "s"}
                    {v.publishedAt && <> · published {when(v.publishedAt)}</>}
                  </div>
                </div>
                <div className="row wrap nogap">
                  {v.status === "draft" ? (
                    <>
                      <a className="btn ghost" href={`#/routes/edit/${v.id}`}>
                        Edit
                      </a>
                      <button className="ghost" onClick={() => void act(() => api.publish(v.id), "Version published")}>
                        Publish
                      </button>
                      <button className="ghost danger-text" onClick={() => void removeDraft(v.id)}>
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
                      <button className="ghost" onClick={() => void archive(v.id)}>
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
