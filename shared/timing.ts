/**
 * Does the video file's clock agree with the phone's clock?
 * GPS times are phone wall-clock times; `videoTimeS` is derived from them without looking at the video.
 * If the finished file is shorter (or longer) than the recorder was running, GPS and footage drift apart.
 */
export const TIME_MISMATCH_WARN_S = 2;

export type TimeCheck = {
  /** seconds the recorder ran (stop time minus start time), or null if unknown */
  recorderWindowS: number | null;
  /** length of the finished video file in seconds, or null if it could not be read */
  videoDurationS: number | null;
  /** recorderWindowS - videoDurationS; positive means the video is shorter than the recorder window */
  timeMismatchS: number | null;
  /** set when the gap is larger than TIME_MISMATCH_WARN_S */
  timeWarning: string | null;
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function timeCheck(recorderWindowMs: number | null, videoDurationMs: number | null): TimeCheck {
  const recorderWindowS = recorderWindowMs === null ? null : round3(recorderWindowMs / 1000);
  const videoDurationS = videoDurationMs === null ? null : round3(videoDurationMs / 1000);
  if (recorderWindowS === null || videoDurationS === null) {
    return { recorderWindowS, videoDurationS, timeMismatchS: null, timeWarning: null };
  }
  const timeMismatchS = round3(recorderWindowS - videoDurationS);
  const timeWarning =
    Math.abs(timeMismatchS) > TIME_MISMATCH_WARN_S
      ? `The video is ${Math.abs(timeMismatchS)} s ${timeMismatchS > 0 ? "shorter" : "longer"} than the time the recorder ran. ` +
        "videoTimeS assumes they match, so GPS may not line up with the footage."
      : null;
  return { recorderWindowS, videoDurationS, timeMismatchS, timeWarning };
}
