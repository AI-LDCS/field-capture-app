import { useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { Badge, Card, SecretBox, useLoad } from "../ui.tsx";

/** Password field with a Generate option. Empty means: the server generates one. */
function PasswordRow({ id, onDone }: { id: string; onDone: (generated?: string) => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const save = async () => {
    setErr("");
    try {
      onDone((await api.setWorkerPassword(id, pw || undefined)).generatedPassword);
      setPw("");
    } catch (x: any) {
      setErr(x.message);
    }
  };
  return (
    <div className="pwrow">
      <div className="row">
        <input
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="New password (8+), or leave empty to generate"
          autoComplete="off"
        />
        <button onClick={() => void save()}>{pw ? "Set password" : "Generate & set"}</button>
      </div>
      <p className="muted small">The worker is signed out everywhere and uses the new password. Workers cannot change it themselves.</p>
      {err && <p className="err small">{err}</p>}
    </div>
  );
}

export function Workers() {
  const { data, err, reload } = useLoad(() => api.workers());
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setMsg("");
    try {
      const r = await api.createWorker(username, displayName, password || undefined);
      setSecret(r.generatedPassword ? { label: `Password for ${r.user.username}`, value: r.generatedPassword } : null);
      setUsername("");
      setDisplayName("");
      setPassword("");
      reload();
    } catch (x: any) {
      setMsg(x.message);
    }
  };
  const act = async (fn: () => Promise<unknown>) => {
    setMsg("");
    try {
      await fn();
      reload();
    } catch (x: any) {
      setMsg(x.message);
    }
  };

  return (
    <>
      <Card title="Add a field worker">
        <form onSubmit={create} className="grid2">
          <label>
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. somchai"
              autoCapitalize="none"
              autoComplete="off"
            />
          </label>
          <label>
            Display name
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="off" />
          </label>
          <label>
            Password
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="8+ characters, or leave empty to generate"
              autoComplete="off"
            />
          </label>
          <div className="row">
            <button disabled={!username}>Create worker</button>
          </div>
        </form>
        <p className="muted small">
          The password never expires and the worker cannot change it. Only you can set a new one, from this page. It is stored hashed, so it
          can be shown only when you set it.
        </p>
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
                {!w.active && <Badge s="deactivated" />}
              </div>
              <div className="row wrap">
                <button
                  className="ghost"
                  onClick={() => {
                    const n = prompt("Display name", w.displayName);
                    if (n !== null) void act(() => api.renameWorker(w.id, n));
                  }}
                >
                  Rename
                </button>
                <button className="ghost" onClick={() => setEditing(editing === w.id ? null : w.id)}>
                  Set password
                </button>
                {w.active ? (
                  <button
                    className="ghost danger-text"
                    onClick={() =>
                      confirm(`Deactivate ${w.username}? They are signed out immediately.`) &&
                      void act(() => api.setWorkerActive(w.id, false))
                    }
                  >
                    Deactivate
                  </button>
                ) : (
                  <button className="ghost" onClick={() => void act(() => api.setWorkerActive(w.id, true))}>
                    Reactivate
                  </button>
                )}
                <button
                  className="ghost danger-text"
                  onClick={() =>
                    confirm(
                      `Delete ${w.username}?\n\nThey are signed out and can never log in again. Their assignments, recordings and video stay, shown as "${w.username} (deleted)". This cannot be undone. To stop access only, use Deactivate.`,
                    ) && void act(() => api.deleteWorker(w.id))
                  }
                >
                  Delete
                </button>
              </div>
            </div>
            {editing === w.id && (
              <PasswordRow
                id={w.id}
                onDone={(generated) => {
                  setEditing(null);
                  setSecret(generated ? { label: `New password for ${w.username}`, value: generated } : null);
                  setMsg(generated ? "" : `Password set for ${w.username}.`);
                  reload();
                }}
              />
            )}
          </div>
        ))}
      </Card>
    </>
  );
}
