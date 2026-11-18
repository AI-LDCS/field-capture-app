const env = process.env;

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === "" ? d : ["1", "true", "yes"].includes(v.toLowerCase()));
const int = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  databaseUrl: env.DATABASE_URL ?? "",
  port: int(env.PORT, 3100),
  host: env.HOST ?? "0.0.0.0",
  /** Browser origins allowed to make state-changing requests (CSRF check). */
  publicOrigins: (env.PUBLIC_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean),
  cookieSecure: bool(env.COOKIE_SECURE, true),
  trustProxy: int(env.TRUST_PROXY, 1),
  s3: {
    endpoint: env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
    region: env.S3_REGION ?? "us-east-1",
    accessKey: env.S3_ACCESS_KEY ?? "",
    secretKey: env.S3_SECRET_KEY ?? "",
    bucket: env.S3_BUCKET ?? "recordings",
  },
  /** Fake GPS and a fake camera for testing without walking. Off unless this is set. */
  devTools: bool(env.ENABLE_DEV_TOOLS, false),
  assembly: {
    partBytes: 8 * 1024 * 1024,
    pollMs: 5000,
    remux: bool(env.REMUX, true),
    concurrency: Math.max(1, int(env.ASSEMBLY_CONCURRENCY, 3)), // videos built at the same time
    fetchAhead: 8, // chunks read from storage at once while building one video
    uploadsInFlight: 4, // parts of the finished file sent to storage at once
  },
  /** The GPU machine that blurs faces and plates. It is not a browser: it sends this bearer token and no cookie. */
  anonymizer: {
    token: env.ANONYMIZER_TOKEN ?? "",
    /** Also make an anonymized copy of the whole video. Off: admins and the worker who recorded it download the original, and only the sampled images are anonymized. */
    videoEnabled: bool(env.ANON_VIDEO_ENABLED, false),
    leaseMinutes: Math.max(1, int(env.ANON_LEASE_MINUTES, 15)), // a claim is lost if the worker is silent this long
    maxAttempts: 3, // claims per recording before it is marked failed
    partBytes: 8 * 1024 * 1024, // the result is streamed to storage in parts this big
    sweepMs: 60_000,
  },
  /** Still images cut from each finished video by the GPU worker (see services/frames.ts). */
  frames: {
    enabled: bool(env.FRAMES_ENABLED, true), // queue the frames job when a video is built
    stepM: int(env.SAMPLE_STEP_M, 3), // metres walked per image
    gapMaxM: int(env.SAMPLE_GAP_M, 15), // a restart this close to where the last recording stopped is one continuous walk
  },
  adminUsername: env.ADMIN_USERNAME ?? "",
  adminPassword: env.ADMIN_PASSWORD ?? "",
  session: {
    absoluteHours: int(env.SESSION_ABSOLUTE_HOURS, 24 * 14),
    idleHours: int(env.SESSION_IDLE_HOURS, 24),
  },
  login: {
    windowMinutes: 15,
    maxFailuresPerUser: 5,
    maxFailuresPerIp: 20,
  },
  password: { workerMinLength: 8, adminMinLength: 12, maxLength: 128 },
};

export function requireConfig() {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  if (config.anonymizer.token && config.anonymizer.token.length < 32) throw new Error("ANONYMIZER_TOKEN must be at least 32 characters");
  if (!(config.frames.stepM >= 1 && config.frames.stepM <= 50)) throw new Error("SAMPLE_STEP_M must be between 1 and 50 (metres)");
  if (!(config.frames.gapMaxM >= 0 && config.frames.gapMaxM <= 1000)) throw new Error("SAMPLE_GAP_M must be between 0 and 1000 (metres)");
  if (!config.s3.accessKey || !config.s3.secretKey) throw new Error("S3_ACCESS_KEY and S3_SECRET_KEY are required");
  if (config.cookieSecure && config.publicOrigins.some((o) => o.startsWith("http://") && !/localhost|127\.0\.0\.1/.test(o))) {
    console.warn("COOKIE_SECURE=true but a non-localhost http:// origin is configured; login will not work there");
  }
}
