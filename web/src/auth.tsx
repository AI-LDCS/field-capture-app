import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { User } from "@shared/types.ts";
import { api, setUnauthenticatedHandler } from "./api.ts";

type Auth = { user: User | null; loading: boolean; logout: () => Promise<void>; setUser: (u: User | null) => void };
const Ctx = createContext<Auth>(null as unknown as Auth);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try { setUser((await api.me()).user); } catch { setUser(null); } finally { setLoading(false); }
  };
  useEffect(() => {
    setUnauthenticatedHandler(() => setUser(null)); // session died (deactivated, expired, password reset)
    void refresh();
  }, []);

  const logout = async () => {
    try { await api.logout(); } catch { /* cookie is cleared server side either way */ }
    setUser(null);
    location.hash = "#/";
  };
  return <Ctx.Provider value={{ user, loading, logout, setUser }}>{children}</Ctx.Provider>;
}

export function Login() {
  const { setUser } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try { setUser((await api.login(username, password)).user); } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
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
