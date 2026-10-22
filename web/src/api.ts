import type {
  AssignmentDetail, AssignmentSummary, RouteSummary, RouteVersion, SegmentInput, User, WorkerRow,
} from "@shared/types.ts";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

let onUnauthenticated: (() => void) | null = null;
export const setUnauthenticatedHandler = (f: () => void) => { onUnauthenticated = f; };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && !path.startsWith("/api/auth/login")) onUnauthenticated?.();
    throw new ApiError(r.status, data.error ?? "error", data.message ?? r.statusText);
  }
  return data as T;
}
const get = <T>(p: string) => request<T>("GET", p);
const post = <T>(p: string, b?: unknown) => request<T>("POST", p, b ?? {});
const put = <T>(p: string, b: unknown) => request<T>("PUT", p, b);
const patch = <T>(p: string, b: unknown) => request<T>("PATCH", p, b);
const del = <T>(p: string) => request<T>("DELETE", p);

export const api = {
  me: () => get<{ user: User }>("/api/auth/me"),
  login: (username: string, password: string) => post<{ user: User }>("/api/auth/login", { username, password }),
  logout: () => post("/api/auth/logout"),
  changePassword: (currentPassword: string, newPassword: string) => post("/api/auth/change-password", { currentPassword, newPassword }),

  workers: () => get<WorkerRow[]>("/api/admin/users"),
  /** generatedPassword is present only when the admin left the password empty */
  createWorker: (username: string, displayName: string, password?: string) =>
    post<{ user: WorkerRow; generatedPassword?: string }>("/api/admin/users", { username, displayName, ...(password ? { password } : {}) }),
  renameWorker: (id: string, displayName: string) => patch<WorkerRow>(`/api/admin/users/${id}`, { displayName }),
  setWorkerActive: (id: string, active: boolean) => post<WorkerRow>(`/api/admin/users/${id}/${active ? "activate" : "deactivate"}`),
  setWorkerPassword: (id: string, password?: string) =>
    post<{ generatedPassword?: string; ok?: boolean }>(`/api/admin/users/${id}/password`, password ? { password } : {}),

  routes: () => get<RouteSummary[]>("/api/admin/routes"),
  version: (vid: string) => get<RouteVersion>(`/api/admin/route-versions/${vid}`),
  createRoute: (name: string, segments: SegmentInput[]) => post<RouteVersion>("/api/admin/routes", { name, segments }),
  saveDraft: (vid: string, name: string, segments: SegmentInput[]) => put<RouteVersion>(`/api/admin/route-versions/${vid}`, { name, segments }),
  deleteDraft: (vid: string) => del(`/api/admin/route-versions/${vid}`),
  newVersion: (routeId: string) => post<RouteVersion>(`/api/admin/routes/${routeId}/new-version`),
  publish: (vid: string) => post<RouteVersion>(`/api/admin/route-versions/${vid}/publish`),
  archive: (vid: string) => post<RouteVersion>(`/api/admin/route-versions/${vid}/archive`),

  assignments: (q: { status?: string; userId?: string } = {}) => {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
    return get<AssignmentSummary[]>(`/api/admin/assignments${p ? `?${p}` : ""}`);
  },
  assignment: (id: string) => get<AssignmentDetail>(`/api/admin/assignments/${id}`),
  createAssignment: (routeVersionId: string, userId: string) =>
    post<AssignmentDetail>("/api/admin/assignments", { routeVersionId, userId }),
  withdrawAssignment: (id: string) => del(`/api/admin/assignments/${id}`),

  myAssignments: () => get<AssignmentSummary[]>("/api/me/assignments"),
  myAssignment: (id: string) => get<AssignmentDetail>(`/api/me/assignments/${id}`),
};
