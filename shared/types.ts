export type LngLat = [number, number]; // GeoJSON order

export type GpsPoint = { seq: number; t: number; lat: number; lng: number; acc: number };

export type Role = "admin" | "worker";
export type RouteVersionStatus = "draft" | "published" | "archived";
export type SegmentStatus = "pending" | "in_progress" | "completed" | "skipped";
export type AssignmentStatus = "assigned" | "in_progress" | "pending_sync" | "completed" | "needs_review";

export type User = { id: string; username: string; displayName: string; role: Role; mustChangePassword: boolean };

export type WorkerRow = {
  id: string; username: string; displayName: string; active: boolean; mustChangePassword: boolean;
  createdAt: string; lastActiveAt: string | null;
};

export type SegmentDef = {
  id: string; order: number; name: string; required: boolean; coords: LngLat[]; minCoverageRatio: number; lengthM: number;
};
export type SegmentInput = { name?: string; required: boolean; coords: LngLat[]; minCoverageRatio?: number };

export type RouteVersion = {
  id: string; routeId: string; routeName: string; version: number; status: RouteVersionStatus;
  createdAt: string; publishedAt: string | null; segments: SegmentDef[];
};
export type RouteSummary = {
  id: string; name: string; createdAt: string;
  versions: {
    id: string; version: number; status: RouteVersionStatus; publishedAt: string | null; createdAt: string;
    segmentCount: number; lengthM: number; assignmentCount: number;
  }[];
};

export type AssignmentSummary = {
  id: string; status: AssignmentStatus; note: string; createdAt: string; updatedAt: string;
  worker: { id: string; username: string; displayName: string };
  route: { id: string; name: string; versionId: string; version: number };
  progress: { segmentsDone: number; segmentsTotal: number; requiredDone: number; requiredTotal: number };
};
export type AssignmentSegment = {
  id: string; routeSegmentId: string; order: number; name: string; required: boolean; status: SegmentStatus;
  skipReason: string | null; completedAt: string | null; coords: LngLat[]; minCoverageRatio: number; lengthM: number;
};
export type AssignmentDetail = AssignmentSummary & { segments: AssignmentSegment[] };
