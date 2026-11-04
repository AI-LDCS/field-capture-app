import "leaflet/dist/leaflet.css";
import "./styles.css";
import { Component, StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Assignments, RoutesPage, Workers } from "./admin.tsx";
import { Downloads } from "./Downloads.tsx";
import { AuthProvider, ChangePassword, Login, SessionBanner, useAuth } from "./auth.tsx";
import Review from "./Review.tsx";
import { EditVersion, NewRoute } from "./RouteEditor.tsx";
import { MyAssignments } from "./worker.tsx";
import WorkerRun from "./worker/RunPage.tsx";

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
  const { user, loading, authLost, logout } = useAuth();
  const hash = useHash();
  const [, page, a, b] = hash.split("/");

  if (loading) return <main><p>Loading…</p></main>;
  if (!user) return <main><Login /></main>;

  const admin = user.role === "admin";
  const link = (h: string, label: string, match: string[]) => (
    <a href={h} className={match.includes(page ?? "") ? "on" : ""}>{label}</a>
  );

  let body;
  if (admin) {
    body =
      page === "downloads" ? <Downloads />
      : page === "workers" ? <Workers />
      : page === "routes" && a === "new" ? <NewRoute />
      : page === "routes" && a === "edit" && b ? <EditVersion key={b} versionId={b} />
      : page === "routes" ? <RoutesPage />
      : page === "assign" ? <Assignments key={a} presetVersionId={a} />
      : page === "assignment" && a ? <Review key={a} id={a} />
      : page === "password" ? <ChangePassword />
      : <Assignments />;
  } else {
    body =
      page === "assignment" && a ? <WorkerRun key={a} id={a} step={b === "onboard" || b === "record" ? b : "home"} />
      : <MyAssignments />;
  }

  return (
    <>
      <header>
        <a href="#/" className="brand" title="Field Capture"><img src="/logo.svg" alt="" width="26" height="26" /><strong>Field Capture</strong></a>
        <nav>
          {admin ? (
            <>
              {link("#/", "Assignments", ["", "assign", "assignment"])}
              {link("#/routes", "Routes", ["routes"])}
              {link("#/workers", "Workers", ["workers"])}
              {link("#/downloads", "Downloads", ["downloads"])}
            </>
          ) : link("#/", "My assignments", ["", "assignment"])}
        </nav>
        <span className="grow" />
        {admin
          ? <a href="#/password" className="small muted" title="Change my password">{user.username}</a>
          : <span className="small muted">{user.displayName || user.username}</span>}
        <button className="ghost small" onClick={() => void logout()}>Sign out</button>
      </header>
      {authLost && <SessionBanner />}
      <main>{body}</main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><Boundary><AuthProvider><Shell /></AuthProvider></Boundary></StrictMode>,
);
