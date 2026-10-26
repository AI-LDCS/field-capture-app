export type LngLat = [number, number]; // GeoJSON order

export type GpsPoint = { seq: number; t: number; lat: number; lng: number; acc: number };

export type Role = "admin" | "worker";
export type RouteVersionStatus = "draft" | "published" | "archived";
export type SegmentStatus = "pending" | "in_progress" | "completed" | "skipped";
/** On the phone. The server only knows "uploading" and "server_verified". */
export type RecordingStatus = "recording" | "interrupted" | "pending_upload" | "uploading" | "upload_interrupted" | "server_verified";
export type AssignmentStatus = "assigned" | "in_progress" | "pending_sync" | "completed" | "needs_review";

export type User = { id: string; username: string; displayName: string; role: Role };

export type WorkerRow = { id: string; username: string; displayName: string; active: boolean; createdAt: string };

/**
 * coords = the points an admin edits: the control points of a curve when `smooth`, else the line itself.
 * lengthM is always the length of the stored (smoothed) line.
 */
export type SegmentDef = {
  id: string; order: number; name: string; required: boolean; smooth: boolean; coords: LngLat[]; minCoverageRatio: number; lengthM: number;
};
export type SegmentInput = { name?: string; required: boolean; smooth?: boolean; coords: LngLat[]; minCoverageRatio?: number };

export type RouteVersion = {
  id: string; routeId: string; routeName: string; version: number; status: RouteVersionStatus;
  createdAt: string; publishedAt: string | null; segments: SegmentDef[];
};
export type RouteSummary = {
  id: string; name: string; createdAt: string;
  versions: {
    id: string; version: number; name: string; status: RouteVersionStatus; publishedAt: string | null; createdAt: string;
    segmentCount: number; lengthM: number; assignmentCount: number;
  }[];
};

export type AssignmentSummary = {
  id: string; status: AssignmentStatus; createdAt: string; updatedAt: string;
  worker: { id: string; username: string; displayName: string; deleted: boolean };
  route: { id: string; name: string; versionId: string; version: number; deleted: boolean };
  progress: { segmentsDone: number; segmentsTotal: number; requiredDone: number; requiredTotal: number };
};
export type GpsQuality = { total: number; poorAccuracy: number; gaps: number; jumps: number; offRoute: number };
export type PreflightOutcome = { result: "passed" | "skipped"; durationMs: number; samples: number; bestAccuracyM: number | null; note?: string };

export type RecordingSummary = {
  id: string;
  status: "uploading" | "server_verified"; // what the server knows; the phone has finer states
  startedAtMs: number;
  endedAtMs: number | null;
  chunkCount: number;
  bytes: number;
  gpsCount: number;
  simulated: boolean;
  stopReason: string | null;
  assembly: "none" | "pending" | "running" | "done" | "failed";
  fileBytes: number | null;
};

/** One verified recording in the admin Downloads list. */
export type DownloadRow = {
  id: string; assignmentId: string; verifiedAt: string; startedAtMs: number; endedAtMs: number | null;
  gpsCount: number; fileBytes: number | null; assembly: RecordingSummary["assembly"]; simulated: boolean;
  worker: { id: string; username: string; displayName: string; deleted: boolean };
  route: { name: string; version: number; deleted: boolean };
};

export type SegmentEvidence = { recordingId: string; coverage: number; firstTMs: number | null; lastTMs: number | null };

export type AssignmentSegment = {
  id: string; routeSegmentId: string; order: number; name: string; required: boolean; status: SegmentStatus;
  skipReason: string | null; completedAt: string | null; coords: LngLat[]; minCoverageRatio: number; lengthM: number;
  coverage: number; evidence: SegmentEvidence[];
};
export type AssignmentDetail = AssignmentSummary & {
  segments: AssignmentSegment[];
  reasons: string[];
  preflight: PreflightOutcome | null;
  quality: GpsQuality | null;
  completedAt: string | null;
  recordings: RecordingSummary[];
};
