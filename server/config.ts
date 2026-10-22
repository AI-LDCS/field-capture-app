const env = process.env;

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === "" ? d : ["1", "true", "yes"].includes(v.toLowerCase()));
const int = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  databaseUrl: env.DATABASE_URL ?? "",
  port: int(env.PORT, 3100),
  host: env.HOST ?? "0.0.0.0",
  /** Browser origins allowed to make state-changing requests (CSRF check). */
  publicOrigins: (env.PUBLIC_ORIGINS ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean),
  cookieSecure: bool(env.COOKIE_SECURE, true),
  trustProxy: int(env.TRUST_PROXY, 1),
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
  password: { minLength: 10, adminMinLength: 12, maxLength: 128 },
};

export function requireConfig() {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  if (config.cookieSecure && config.publicOrigins.some((o) => o.startsWith("http://") && !/localhost|127\.0\.0\.1/.test(o))) {
    console.warn("COOKIE_SECURE=true but a non-localhost http:// origin is configured; login will not work there");
  }
}
