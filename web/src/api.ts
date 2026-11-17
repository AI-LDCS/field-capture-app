import type {
  AssignmentDetail,
  AssignmentSummary,
  DownloadRow,
  PreflightOutcome,
  RouteSummary,
  RouteVersion,
  SegmentInput,
  User,
  WorkerRow,
} from "@shared/types.ts";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The server answered that this does not exist (or is not yours). A failed connection is not this. */
export const isNotFound = (e: unknown) => e instanceof ApiError && e.status === 404;

let onUnauthenticated: (() => void) | null = null;
export const setUnauthenticatedHandler = (f: () => void) => {
  onUnauthenticated = f;
};

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
  me: () => get<{ user: User; devTools: boolean }>("/api/auth/me"),
  login: (username: string, password: string) => post<{ user: User; devTools: boolean }>("/api/auth/login", { username, password }),
  logout: () => post("/api/auth/logout"),
  changePassword: (currentPassword: string, newPassword: string) => post("/api/auth/change-password", { currentPassword, newPassword }),

  workers: () => get<WorkerRow[]>("/api/admin/users"),
  /** generatedPassword is present only when the admin left the password empty */
  createWorker: (username: string, displayName: string, password?: string) =>
    post<{ user: WorkerRow; generatedPassword?: string }>("/api/admin/users", { username, displayName, ...(password ? { password } : {}) }),
  renameWorker: (id: string, displayName: string) => patch<WorkerRow>(`/api/admin/users/${id}`, { displayName }),
  deleteWorker: (id: string) => del<{ ok: true }>(`/api/admin/users/${id}`),
  setWorkerActive: (id: string, active: boolean) => post<WorkerRow>(`/api/admin/users/${id}/${active ? "activate" : "deactivate"}`),
  setWorkerPassword: (id: string, password?: string) =>
    post<{ generatedPassword?: string; ok?: boolean }>(`/api/admin/users/${id}/password`, password ? { password } : {}),

  routes: () => get<RouteSummary[]>("/api/admin/routes"),
  version: (vid: string) => get<RouteVersion>(`/api/admin/route-versions/${vid}`),
  createRoute: (name: string, segments: SegmentInput[]) => post<RouteVersion>("/api/admin/routes", { name, segments }),
  saveDraft: (vid: string, name: string, segments: SegmentInput[]) =>
    put<RouteVersion>(`/api/admin/route-versions/${vid}`, { name, segments }),
  deleteDraft: (vid: string) => del(`/api/admin/route-versions/${vid}`),
  renameRoute: (routeId: string, name: string) => patch<{ id: string; name: string }>(`/api/admin/routes/${routeId}`, { name }),
  deleteRoute: (routeId: string) => del<{ ok: true }>(`/api/admin/routes/${routeId}`),
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
  myPreflight: (id: string, outcome: PreflightOutcome) => post(`/api/me/assignments/${id}/preflight`, outcome),
  mySkip: (id: string, segId: string, reason: string) =>
    post<AssignmentDetail>(`/api/me/assignments/${id}/segments/${segId}/skip`, { reason }),
  myUnskip: (id: string, segId: string) => post<AssignmentDetail>(`/api/me/assignments/${id}/segments/${segId}/unskip`),
  myFinish: (id: string) => post<AssignmentDetail>(`/api/me/assignments/${id}/finish`),
  /** raw GPS of one recording, for the admin review map */
  myRecordingGps: (rid: string) =>
    get<{ seq: number; t: number; lat: number; lng: number; acc: number }[]>(`/api/me/recordings/${rid}/gps`),
  recordingGps: (rid: string) =>
    get<{ seq: number; t: number; lat: number; lng: number; acc: number }[]>(`/api/admin/recordings/${rid}/gps`),
  reviewAssignment: (id: string, decision: "approve" | "reject") =>
    post<AssignmentDetail>(`/api/admin/assignments/${id}/review`, { decision }),
  assignmentAudit: (id: string) =>
    get<{ id: number; at: string; action: string; details: unknown; actor: string | null }[]>(`/api/admin/assignments/${id}/audit`),
  reEvaluate: (id: string) => post<AssignmentDetail>(`/api/admin/assignments/${id}/re-evaluate`),
  downloads: () => get<DownloadRow[]>("/api/admin/recordings"),
  reassemble: (rid: string) => post(`/api/admin/recordings/${rid}/reassemble`),
  reanonymize: (rid: string) => post(`/api/admin/recordings/${rid}/reanonymize`),
};
