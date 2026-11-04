import { CONFIG } from "@shared/config.ts";
import { getSettings } from "./settings.ts";

export type CameraInfo = {
  stream: MediaStream;
  label: string;
  facing: string | null;
  width: number;
  height: number;
  fake: boolean;
  stop: () => void;
};

function fakeCamera(): CameraInfo {
  const c = document.createElement("canvas");
  c.width = 1280;
  c.height = 720;
  const g = c.getContext("2d")!;
  let n = 0;
  const draw = () => {
    n++;
    g.fillStyle = `hsl(${(n * 2) % 360} 40% 25%)`;
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#fff";
    g.font = "bold 64px monospace";
    g.fillText("FAKE CAMERA", 60, 140);
    g.font = "48px monospace";
    g.fillText(new Date().toISOString(), 60, 230);
    g.fillRect((n * 8) % c.width, 400, 120, 120);
  };
  draw();
  const timer = window.setInterval(draw, 66);
  const stream = c.captureStream(15);
  return {
    stream,
    label: "canvas (fake)",
    facing: "environment",
    width: c.width,
    height: c.height,
    fake: true,
    stop: () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

export async function openCamera(): Promise<CameraInfo> {
  if (getSettings().fake) return fakeCamera();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera API unavailable (needs HTTPS)");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: CONFIG.recording.idealWidth },
      height: { ideal: CONFIG.recording.idealHeight },
    },
  });
  const track = stream.getVideoTracks()[0];
  const s = track.getSettings();
  return {
    stream,
    label: track.label,
    facing: s.facingMode ?? null,
    width: s.width ?? 0,
    height: s.height ?? 0,
    fake: false,
    stop: () => stream.getTracks().forEach((t) => t.stop()),
  };
}

export async function storageCheck() {
  const est = (await navigator.storage?.estimate?.()) ?? {};
  const quota = est.quota ?? 0;
  const usage = est.usage ?? 0;
  let persisted = false;
  try {
    persisted = (await navigator.storage?.persisted?.()) ?? false;
  } catch {
    /* ignore */
  }
  if (!persisted) {
    try {
      persisted = (await navigator.storage?.persist?.()) ?? false;
    } catch {
      /* ignore */
    }
  }
  const free = Math.max(0, quota - usage);
  return { quota, usage, free, persisted, ok: quota === 0 ? true : free >= CONFIG.recording.minFreeBytes };
}
