import { useSyncExternalStore } from "react";
import type { CameraInfo } from "./camera.ts";
import type { ActiveRecording } from "./recorder.ts";

/** Camera + live recording live outside React so navigating pages does not kill them. */
type State = { camera: CameraInfo | null; active: ActiveRecording | null; activeAssignmentId: string | null; lastStop: string | null };
let state: State = { camera: null, active: null, activeAssignmentId: null, lastStop: null };
const subs = new Set<() => void>();

export const getSession = () => state;
export function setSession(patch: Partial<State>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}
export const useSession = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), getSession);
export const closeCamera = () => {
  state.camera?.stop();
  setSession({ camera: null });
};

export const isRecording = () => !!state.active;

window.addEventListener("beforeunload", (e) => {
  if (state.active) e.preventDefault();
});
