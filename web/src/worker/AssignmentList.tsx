import { api } from "../api.ts";
import { ChevronRight } from "../icons.tsx";
import { Badge, Card, useLoad, when } from "../ui.tsx";

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
              required {a.progress.requiredDone}/{a.progress.requiredTotal} · assigned {when(a.createdAt)}
            </div>
          </div>
          <span className="chevron">
            <ChevronRight />
          </span>
        </a>
      ))}
    </Card>
  );
}
