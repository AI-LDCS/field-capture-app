import "leaflet/dist/leaflet.css";
import "./styles.css";
import { Component, StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Assignments, RoutesPage, Workers } from "./admin.tsx";
import { AuthProvider, ChangePassword, Login, useAuth } from "./auth.tsx";
import { EditVersion, NewRoute } from "./RouteEditor.tsx";
import { AssignmentView, MyAssignments } from "./worker.tsx";

const useHash = () => {
  const [h, setH] = useState(location.hash || "#/");
  useEffect(() => {
    const f = () => setH(location.hash || "#/");
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  return h;
};

/** One broken screen must not blank the whole app. */
class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e.message : String(e) }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main>
        <div className="card narrow">
          <h2>Something went wrong</h2>
          <p className="err small">{this.state.error}</p>
          <button onClick={() => { location.hash = "#/"; location.reload(); }}>Reload</button>
        </div>
      </main>
    );
  }
}

function Shell() {
  const { user, loading, logout } = useAuth();
  const hash = useHash();
  const [, page, a, b] = hash.split("/");

  if (loading) return <main><p>Loading…</p></main>;
  if (!user) return <main><Login /></main>;
  if (user.mustChangePassword) return <main><ChangePassword forced /></main>;

  const admin = user.role === "admin";
  const link = (h: string, label: string, match: string[]) => (
    <a href={h} className={match.includes(page ?? "") ? "on" : ""}>{label}</a>
  );

  let body;
  if (admin) {
    body =
      page === "workers" ? <Workers />
      : page === "routes" && a === "new" ? <NewRoute />
      : page === "routes" && a === "edit" && b ? <EditVersion key={b} versionId={b} />
      : page === "routes" ? <RoutesPage />
      : page === "assign" ? <Assignments key={a} presetVersionId={a} />
      : page === "assignment" && a ? <AssignmentView key={a} id={a} admin />
      : page === "password" ? <ChangePassword />
      : <Assignments />;
  } else {
    body =
      page === "assignment" && a ? <AssignmentView key={a} id={a} />
      : page === "password" ? <ChangePassword />
      : <MyAssignments />;
  }

  return (
    <>
      <header>
        <a href="#/" className="brand"><strong>Field Capture</strong></a>
        <nav>
          {admin ? (
            <>
              {link("#/", "Assignments", ["", "assign", "assignment"])}
              {link("#/routes", "Routes", ["routes"])}
              {link("#/workers", "Workers", ["workers"])}
            </>
          ) : link("#/", "My assignments", ["", "assignment"])}
        </nav>
        <span className="grow" />
        <a href="#/password" className="small muted">{user.username}</a>
        <button className="ghost small" onClick={() => void logout()}>Sign out</button>
      </header>
      <main>{body}</main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><Boundary><AuthProvider><Shell /></AuthProvider></Boundary></StrictMode>,
);
