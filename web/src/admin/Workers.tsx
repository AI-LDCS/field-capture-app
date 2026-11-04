import { useState, type FormEvent } from "react";
import type { WorkerRow } from "@shared/types.ts";
import { api } from "../api.ts";
import { confirmDialog, Modal, promptDialog, toast } from "../feedback.tsx";
import { Badge, Card, Menu, SecretModal, useLoad } from "../ui.tsx";

/** Empty means: the server generates one. */
function PasswordModal({ worker, onClose, onDone }: { worker: WorkerRow; onClose: () => void; onDone: (generated?: string) => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      onDone((await api.setWorkerPassword(worker.id, pw || undefined)).generatedPassword);
    } catch (x: any) {
      setErr(x.message);
    }
  };
  return (
    <Modal title={`Set password for ${worker.username}`} onClose={onClose}>
      <form onSubmit={save}>
        <div className="modal-body">
          <label>
            New password
            <input
              data-autofocus=""
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="8+ characters, or leave empty to generate"
              autoComplete="off"
            />
          </label>
          <p className="muted small row">
            The worker is signed out everywhere and uses the new password. Workers cannot change it themselves.
          </p>
          {err && <p className="err small">{err}</p>}
        </div>
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit">{pw ? "Set password" : "Generate & set"}</button>
        </div>
      </form>
    </Modal>
  );
}

export function Workers() {
  const { data, err, reload } = useLoad(() => api.workers());
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [editing, setEditing] = useState<WorkerRow | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api.createWorker(username, displayName, password || undefined);
      if (r.generatedPassword) setSecret({ label: `Password for ${r.user.username}`, value: r.generatedPassword });
      else toast.success(`Worker ${r.user.username} created`);
      setUsername("");
      setDisplayName("");
      setPassword("");
      reload();
    } catch (x: any) {
      toast.error(x.message);
    }
  };
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast.success(done);
      reload();
    } catch (x: any) {
      toast.error(x.message);
    }
  };

  const rename = async (w: WorkerRow) => {
    const name = await promptDialog({
      title: `Rename ${w.username}`,
      label: "Display name",
      initial: w.displayName,
      confirmLabel: "Save",
      allowEmpty: true,
    });
    if (name !== null) void act(() => api.renameWorker(w.id, name), "Name saved");
  };
  const deactivate = async (w: WorkerRow) => {
    const ok = await confirmDialog({
      title: `Deactivate ${w.username}?`,
      body: "They are signed out immediately and cannot sign in. You can reactivate them later.",
      confirmLabel: "Deactivate",
      danger: true,
    });
    if (ok) void act(() => api.setWorkerActive(w.id, false), `${w.username} deactivated`);
  };
  const remove = async (w: WorkerRow) => {
    const ok = await confirmDialog({
      title: `Delete ${w.username}?`,
      body: (
        <>
          <p>
            They are signed out and can never sign in again. Their assignments, recordings and video stay, shown as "{w.username}{" "}
            (deleted)".
          </p>
          <p>This cannot be undone. To stop access only, use Deactivate.</p>
        </>
      ),
      confirmLabel: "Delete worker",
      danger: true,
    });
    if (ok) void act(() => api.deleteWorker(w.id), `${w.username} deleted`);
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
          <div>
            <button disabled={!username}>Create worker</button>
          </div>
        </form>
        <p className="muted small">
          The password never expires and the worker cannot change it. Only you can set a new one, from this page. It is stored hashed, so it
          can be shown only when you set it.
        </p>
      </Card>

      <Card title="Field workers">
        {err && <p className="err">{err}</p>}
        {data?.length === 0 && <p className="muted">No workers yet.</p>}
        {data?.map((w) => (
          <div key={w.id} className="item row between">
            <div>
              <strong>{w.username}</strong> {w.displayName && <span className="muted">· {w.displayName}</span>}{" "}
              {!w.active && <Badge s="deactivated" />}
            </div>
            <div className="row nogap">
              <button className="ghost" onClick={() => setEditing(w)}>
                Set password
              </button>
              <Menu
                label={`More actions for ${w.username}`}
                items={[
                  { label: "Rename", onClick: () => void rename(w) },
                  w.active
                    ? { label: "Deactivate", danger: true, onClick: () => void deactivate(w) }
                    : { label: "Reactivate", onClick: () => void act(() => api.setWorkerActive(w.id, true), `${w.username} reactivated`) },
                  { label: "Delete", danger: true, onClick: () => void remove(w) },
                ]}
              />
            </div>
          </div>
        ))}
      </Card>

      {editing && (
        <PasswordModal
          worker={editing}
          onClose={() => setEditing(null)}
          onDone={(generated) => {
            if (generated) setSecret({ label: `New password for ${editing.username}`, value: generated });
            else toast.success(`Password set for ${editing.username}`);
            setEditing(null);
            reload();
          }}
        />
      )}
      {secret && <SecretModal {...secret} onClose={() => setSecret(null)} />}
    </>
  );
}
