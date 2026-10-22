import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { User } from "@shared/types.ts";
import { api, setUnauthenticatedHandler } from "./api.ts";
import { setLocalUser, unsentSummary } from "./worker/localdb.ts";
import { isRecording, useSession } from "./worker/session.ts";
import { setDevTools } from "./worker/settings.ts";
import { resumeUploader, startUploader, stopUploader } from "./worker/uploader.ts";

type Auth = {
  user: User | null;
  loading: boolean;
  /** the session ended while a recording was running: the recording goes on, uploads wait */
  authLost: boolean;
  logout: () => Promise<void>;
  signedIn: (u: User, devTools: boolean) => void;
  relogged: () => void;
};
const Ctx = createContext<Auth>(null as unknown as Auth);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authLost, setAuthLost] = useState(false);
  const { active } = useSession();

  const signedIn = (u: User, devTools: boolean) => {
    setDevTools(devTools);
    setUserState(u);
  };

  useEffect(() => {
    // a 401 must never replace the screen while someone is recording
    setUnauthenticatedHandler(() => { if (isRecording()) setAuthLost(true); else setUserState(null); });
    api.me().then((r) => signedIn(r.user, r.devTools)).catch(() => setUserState(null)).finally(() => setLoading(false));
  }, []);

  // what is stored on the phone belongs to the signed-in user, and only their uploader runs
  useEffect(() => {
    if (user?.role === "worker") { setLocalUser(user.id); startUploader(); }
    else { stopUploader(); setLocalUser(null); }
  }, [user?.id, user?.role]);

  // the recording ended: now the lost session can show the login screen
  useEffect(() => {
    if (authLost && !active) { setAuthLost(false); setUserState(null); }
  }, [authLost, active]);

  const logout = async () => {
    if (isRecording()) { alert("Stop the recording first."); return; }
    if (user?.role === "worker") {
      const u = await unsentSummary().catch(() => ({ recordings: 0, chunks: 0 }));
      if (u.recordings > 0 && !confirm(`${u.recordings} recording(s) have not finished uploading. They stay on this phone and upload when you sign in again. Sign out anyway?`)) return;
    }
    try { await api.logout(); } catch { /* the cookie is cleared server side either way */ }
    setUserState(null);
    location.hash = "#/";
  };

  const relogged = () => { setAuthLost(false); resumeUploader(); };
  return <Ctx.Provider value={{ user, loading, authLost, logout, signedIn, relogged }}>{children}</Ctx.Provider>;
}

/** Shown on top of a running recording when the session ended. Same user only. */
export function SessionBanner() {
  const { user, relogged } = useAuth();
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const go = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      const r = await api.login(user!.username, pw);
      if (r.user.id !== user!.id) { await api.logout(); throw new Error("wrong user"); }
      setPw("");
      relogged();
    } catch (x: any) { setErr(x.message); }
  };
  return (
    <form className="banner" onSubmit={go}>
      <strong>Signed out.</strong> The recording continues and uploads wait. Sign in again as {user?.username} to upload.
      <div className="row">
        <input type="password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
        <button disabled={!pw}>Sign in</button>
      </div>
      {err && <span className="err small">{err}</span>}
    </form>
  );
}

export function Login() {
  const { signedIn } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try { const r = await api.login(username, password); signedIn(r.user, r.devTools); } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <form className="card narrow" onSubmit={submit}>
      <h2>Sign in</h2>
      <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoFocus /></label>
      <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
      {err && <p className="err">{err}</p>}
      <button disabled={busy || !username || !password}>Sign in</button>
    </form>
  );
}

/** Only the admin account has this. Workers' passwords are set by an admin. */
export function ChangePassword() {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    setDone(false);
    if (next !== again) return setErr("The new passwords do not match");
    try {
      await api.changePassword(cur, next);
      setDone(true);
      setCur(""); setNext(""); setAgain("");
    } catch (x: any) { setErr(x.message); }
  };
  return (
    <form className="card narrow" onSubmit={submit}>
      <h2>Change my password</h2>
      <label>Current password<input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></label>
      <label>New password (12+ characters)<input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></label>
      <label>New password again<input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" /></label>
      {err && <p className="err">{err}</p>}
      {done && <p className="ok">Password changed. Your other devices were signed out.</p>}
      <button disabled={!cur || !next || !again}>Change password</button>
    </form>
  );
}
