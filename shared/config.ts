// Tunable starting values. Not guarantees of GPS accuracy.
export const CONFIG = {
  preflight: {
    maxDurationMs: 90_000,
    targetAccuracyM: 15,
    windowMs: 12_000, // stability window (10-15 s)
    minSamples: 5,
    maxSpreadM: 8, // max distance of any sample from window centroid
  },
  coverage: {
    bufferM: 25, // how far beside the line a GPS point may be and still count as on it
    reachM: 5, // how far along the line, either side, a single GPS point covers
    stepM: 5, // segment densify step
    defaultMinRatio: 0.9,
    maxAccuracyM: 50, // points worse than this are kept but flagged, not counted
  },
  quality: {
    gapMs: 10_000, // gap between consecutive points while recording
    jumpSpeedMps: 15, // implied speed above this = jump
    offRouteM: 50,
    reviewBadRatio: 0.2, // share of flagged points that triggers review
    reviewMaxGaps: 3,
  },
  recording: {
    timesliceMs: 2000,
    videoBitsPerSecond: 4_000_000,
    idealWidth: 1920,
    idealHeight: 1080,
    minFreeBytes: 500 * 1024 * 1024, // needed to start; below this the recording screen warns
    stopFreeBytes: 200 * 1024 * 1024, // below this a recording stops cleanly, while there is still room to save it
  },
  upload: {
    retryIntervalMs: 3000,
    gpsBatchSize: 200,
  },
} as const;
