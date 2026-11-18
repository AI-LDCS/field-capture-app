# CPU affinity: the app and the GPU worker on one machine

If the field-capture stack and the anonymizer worker (`video-anonymizer/`) run on the **same machine**, they share its CPUs. Left alone, a busy worker can slow the phones' uploads, and a busy upload can slow the worker. Pinning each to its own CPUs removes that. If they run on different machines, you do not need any of this.

## What each side does with the CPU

| Part | What it needs | When |
| --- | --- | --- |
| **Stack** (`app`, `db`, `rustfs`, proxy) | Hashing and storing chunks, the database, building each finished video (`ffmpeg -c copy`, `ffprobe`), serving downloads and ZIPs. Wants low latency while phones upload. | Whenever someone records or downloads |
| **Worker, images job** (default) | Decoding the video once, scoring every frame for sharpness, saving PNGs, running the face and plate model on the GPU. Short bursts. | A minute or two per recording |
| **Worker, whole-video job** (optional) | Decoding and re-encoding every frame. Much heavier. | Only if `ANON_VIDEO_ENABLED=true` and the worker runs `--kinds frames,video` |

## What it costs: measured

On a 6-core machine (Intel i7-9750H, no hyper-threading) with a GTX 1660 Ti, one 4.4 minute 1080p recording (1265 frames, 88 images at 3 m), the whole images job including anonymizing and tagging:

| CPUs given to the worker | Time | Peak memory |
| --- | --- | --- |
| 4 (`2-5`) | 81 s | 880 MiB |
| 2 (`4-5`) | 89 s | (not measured reliably) |

Two cores were only about 10% slower than four. The images job is limited by decoding the video and by the GPU, not by the number of CPUs, so **the worker needs few CPUs and the rest should go to the stack**. The idle stack used about 0.4 GiB of memory. This machine has 5.8 GiB in total, so memory, not CPU, is the tighter limit; keep an eye on it (see below).

## What to do

Use a Docker **`cpuset`**, not `cpus:`. With a `cpuset` the worker sees only its own CPUs and sizes its threads from them by itself (its log says `N CPU thread(s)`). A `cpus:` quota leaves it believing it owns every CPU, so it starts too many threads.

A starting point (CPU numbers start at 0):

| CPUs in the machine | Stack | Worker |
| --- | --- | --- |
| 4 | `0-1` | `2-3` |
| 6 | `0-3` | `4-5` |
| 8 | `0-3` | `4-7` |
| 12 or more | `0-5` | the rest |

Give the worker more if it also makes whole-video copies (`--kinds frames,video`): re-encoding scales with the CPUs. Give the stack more if many workers record at once.

Both repositories have an opt-in override file. They change nothing until you use them.

**Stack** (in `field-capture-app/`). Add `STACK_CPUSET=0-3` to `.env`, or set it in the command:

```bash
docker compose -f docker-compose.yml -f docker-compose.cpuset.yml --profile tailnet up -d
```

**Worker** (in `video-anonymizer/`):

```bash
ANON_CPUSET=4-5 docker compose --env-file ../field-capture-app/.env \
  -f docker-compose.yml -f docker-compose.cpuset.yml --profile gpu up -d
```

Recreating the containers is enough; no data is touched.

## Check that it worked

```bash
docker inspect -f '{{.Name}} {{.HostConfig.CpusetCpus}}' $(docker ps -q)   # which CPUs each container may use
docker logs video-anonymizer-worker-gpu-1 | head -1                          # "... 2 CPU thread(s) each"
docker stats --no-stream                                                     # CPU and memory now
nvidia-smi                                                                   # the GPU, which is where the detection runs
```

## Other settings that help on a small machine

| Setting | Effect |
| --- | --- |
| `ASSEMBLY_CONCURRENCY` (app, default 3) | Videos built at the same time. Lower it to 1 or 2 on a stack with few CPUs. |
| `ANON_JOBS` (worker, default 1) | Recordings processed at once. Keep 1 here: more jobs multiply the memory. |
| `ANON_EXTRA='--workers 2'` (worker) | Number of CPU threads for decoding, encoding and saving; overrides what the worker works out from its CPUs. |
| `mem_limit:` (either side, in an override file) | A hard memory ceiling, so a runaway job is stopped instead of freezing the machine. Not set by default. Leave at least 1 GiB per running recording for the worker. |

## Limits of this

- A `cpuset` keeps a container **on** certain CPUs; it does not keep other things **off** them. The kernel and other programs on the machine can still use them. For hard isolation, reserve CPUs for the host with the `isolcpus` kernel option; this is rarely needed here.
- The GPU is not affected by any of this. The two never compete for it unless something else on the machine uses it.
- The numbers above are for one machine and one recording. Measure on yours: run the worker on a test recording with different `ANON_CPUSET` values and compare the time in its log.
