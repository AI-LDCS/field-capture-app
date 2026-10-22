import { MapContainer, Polyline } from "react-leaflet";
import type { AssignmentDetail } from "@shared/types.ts";
import { api } from "./api.ts";
import { Badge, Card, FitTo, Tiles, km, ll, useLoad, when } from "./ui.tsx";

export function MyAssignments() {
  const { data, err } = useLoad(() => api.myAssignments());
  return (
    <Card title="My assignments">
      {err && <p className="err">{err}</p>}
      {data?.length === 0 && <p className="muted">Nothing assigned to you yet.</p>}
      {data?.map((a) => (
        <a key={a.id} className="item row between linkrow" href={`#/assignment/${a.id}`}>
          <div>
            <strong>{a.route.name}</strong> <Badge s={a.status} />
            <div className="small muted">
              required {a.progress.requiredDone}/{a.progress.requiredTotal} · assigned {when(a.createdAt)}{a.note && <> · “{a.note}”</>}
            </div>
          </div>
          <span className="muted">›</span>
        </a>
      ))}
    </Card>
  );
}

const segColor = (s: AssignmentDetail["segments"][number]) =>
  s.status === "completed" ? "#16a34a" : s.status === "skipped" ? "#9ca3af" : s.required ? "#1d4ed8" : "#ea580c";

/** Worker view of their own assignment; the same component backs the admin's read-only view. */
export function AssignmentView({ id, admin }: { id: string; admin?: boolean }) {
  const { data, err } = useLoad(() => (admin ? api.assignment(id) : api.myAssignment(id)), [id, admin]);
  if (err) return <><p className="err">{err}</p><a className="btn ghost" href="#/">Back</a></>;
  if (!data) return <p>Loading…</p>;
  const total = data.segments.reduce((a, s) => a + s.lengthM, 0);
  const pts = data.segments.flatMap((s) => s.coords);

  return (
    <>
      <Card title={data.route.name} right={<Badge s={data.status} />}>
        <p className="small muted">
          Version {data.route.version} · {data.segments.length} segments · {km(total)}
          {admin && <> · worker <strong>{data.worker.username}</strong></>}
        </p>
        {data.note && <p>“{data.note}”</p>}
      </Card>

      <div className="map">
        <MapContainer center={[13.7563, 100.5018]} zoom={16} style={{ height: "100%" }}>
          <Tiles />
          <FitTo pts={pts} />
          {data.segments.map((s) => (
            <Polyline key={s.id} positions={s.coords.map(ll)} pathOptions={{ color: segColor(s), weight: 6, dashArray: s.required ? undefined : "8 8" }} />
          ))}
        </MapContainer>
      </div>
      <p className="small muted"><span className="swatch" style={{ background: "#1d4ed8" }} /> required <span className="swatch dashed" /> optional <span className="swatch" style={{ background: "#16a34a" }} /> done <span className="swatch" style={{ background: "#9ca3af" }} /> skipped</p>

      <Card title="Segments">
        {data.segments.map((s) => (
          <div key={s.id} className="item row between">
            <div>#{s.order + 1} <Badge s={s.required ? "required" : "optional"} /> <span className="muted small">{Math.round(s.lengthM)} m · must cover {(s.minCoverageRatio * 100).toFixed(0)}%</span></div>
            <Badge s={s.status} />
          </div>
        ))}
      </Card>

      {!admin && (
        <Card title="Recording">
          <p className="muted">Recording and upload arrive in the next milestone. For now you can see the route you are assigned.</p>
          <a className="btn ghost" href="#/">Back to my assignments</a>
        </Card>
      )}
      {admin && <a className="btn ghost" href="#/">Back</a>}
    </>
  );
}
