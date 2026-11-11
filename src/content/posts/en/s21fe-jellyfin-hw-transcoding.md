---
title: "Hardware transcoding for Jellyfin in Docker, on a phone"
description: "How I got Jellyfin in Docker to use a Galaxy S21 FE's hardware video encoder through a bridge to MediaCodec, and why decoding stays in software."
pubDate: 2026-11-11T08:03:00-05:00
tags: [android, docker, jellyfin, ffmpeg]
category: android
draft: false
lang: en
translationKey: s21fe-jellyfin-hw-transcoding
repo: https://github.com/parziva-1/jellyfin-hwaccel-bridge
metric:
  value: "5.8x"
  label: "faster HEVC transcoding"
specs:
  - { label: "Phone", value: "Samsung Galaxy S21 FE (Exynos 2100)" }
  - { label: "Encode", value: "hardware (h264_mediacodec / hevc_mediacodec)" }
  - { label: "Decode", value: "always software" }
  - { label: "Jellyfin", value: "in Docker, untouched" }
---

Jellyfin runs in Docker on my phone, and the chip has a hardware video encoder that no container can reach. I solved it with a three-piece bridge. This is part 2 of the series "A phone as a server"; [part 1](/en/posts/s21fe-docker-server/) covers how I got Docker onto the phone.

## The problem: the encoder is right there, out of reach

Transcoding means converting a video to another format or quality so the client can play it. Done in software it eats CPU. My phone has a hardware encoder inside the Exynos 2100, and Android exposes it through `AMediaCodec`, which lives in `libmediandk.so`.

That library is built against bionic, Android's C library. A Debian or Alpine container uses glibc or musl, which are different C libraries. A glibc/musl binary cannot `dlopen()` (load at runtime) a bionic `.so`. It does not matter who builds ffmpeg or with which flags: `--enable-mediacodec` inside a normal container never reaches the hardware sitting in the same kernel.

Where I started: 100 % software transcoding. I measured HEVC (H.265, a more efficient but heavier-to-process format) at only 1.18x real time. Here "x real time" measures speed: 1x is exactly playback speed, so 1.18x leaves almost no headroom before playback stutters.

## The idea: Jellyfin does not need to leave Docker

My first thought was to move Jellyfin into Termux. That is unnecessary. Jellyfin is a .NET server with no Android dependency; it only runs `ffmpeg` as an external process, with a command line and a configurable path. The ABI mismatch is a property of the ffmpeg binary, not of Jellyfin.

I also ruled out building my own ffmpeg inside the container: without a full bionic userland it can't work, and even then hardware decode in a headless process isn't fixed by rebuilding (see below).

## How it is wired

Three pieces, all in the repository:

1. `bridge-client.pl` (inside the container). The fake ffmpeg: you point Jellyfin's `--ffmpeg` flag at this script. It takes the same arguments, sends stdout and stderr back live, and exits with the code a real ffmpeg would. It is Perl because the Jellyfin image (Debian-based) already ships it, so nothing extra to install.
2. `bridge-daemon.py` (on the host, in Termux). A daemon that listens only on the Docker network's gateway address, never on the LAN. It receives the argument list, translates container paths into the real host paths (the same shared volumes, seen from outside) and spawns the wrapper.
3. `wrapper-ffmpeg.sh` (on the host). It rewrites only the encoder (`-c:v libx264` becomes `h264_mediacodec`, same for HEVC), strips options that mean nothing to a hardware encoder (`-preset`, `-crf`) and hands everything else to the real Termux ffmpeg.

```text
Jellyfin → bridge-client.pl ──(only arguments and text)──► bridge-daemon.py
                                                              │ translates paths
                                                              ▼
                                       wrapper-ffmpeg.sh → ffmpeg + MediaCodec
```

Only arguments and output text cross the bridge. The video never does: input and output sit on volumes both sides already share. That is why it is fast and simple.

## Why decoding stays in software

Once the encoder works, the temptation is to pass `-hwaccel mediacodec` to the decoder too. Don't. MediaCodec decoding expects a real Android app context (a drawing surface backed by an `Activity`). A headless process has none, and the result is not a clean error: it hangs, ignores SIGTERM, and only SIGKILL stops it. As far as I could find out, it's a limitation of how MediaCodec works, not something you can fix with ffmpeg options.

So the rule is hard: the wrapper only rewrites the encoder and strips any `-hwaccel mediacodec` that comes in. Decode is always software, encode is hardware.

> [!WARNING]
> Building ffmpeg with `--disable-decoder=h264_mediacodec` prevents the mistake but unlocks nothing. It is only a safety net.

## Fallback to software

The hardware encoder also rejects or hangs on some files. The wrapper handles that like this:

- It watches the HLS segment folder for the entire life of the process. If 20 seconds pass with no file modification time advancing, it kills the hardware attempt (SIGTERM, then SIGKILL if ignored).
- It silently retries with a software encode. One incompatible file degrades to software speed, not to a broken video.
- It forces `format=nv12,setrange=tv` right before the encoder. Some old codecs decode to a pixel layout the encoder claims to support but hangs on.

With real traffic I saw the full cycle (hardware hang, fallback, correct delivery) happen with real traffic.

## Results

Measured with real content from my library (one H.264 file and one HEVC file), in times real time (1x = exactly playback speed):

| Case | Software only | SW decode + HW encode |
|---|---|---|
| H.264 | 2.82x | 7.48x |
| HEVC | 1.18x | 6.82x |

HEVC was the critical case: it went from almost no margin to comfortable headroom. In pure-encode stress tests (45 s at 1080p) I measured 4.3x to 4.8x, with two concurrent sessions running fine. That is lower than the 6.82x in the table because it was measured differently: pure encode in a sustained 45 s test with two sessions at once, rather than transcoding one real file.

After moving Jellyfin from 10.11 to 12.1 and a Termux ffmpeg update, I reran four synthetic tests (H.264, MPEG-2, WMV1 and WMV2). All four used `h264_mediacodec` for real, not a fallback. The daemon survived because it lives on the host, outside the container lifecycle.

## Three things that cost me time

> [!FAIL]
> My first production cutover had to be rolled back eight minutes later. It took five attempts to get stable, and each one exposed a different bug.

- The `file:` prefix: Jellyfin passes paths like `file:/path`. If you don't translate that form too, the path isn't found. This was the real cause of two seemingly different "bugs".
- A stdout deadlock: for a transcode, Jellyfin does not read the process's stdout, only stderr. The client wrote to stdout with a blocking call, the pipe buffer (about 64 KB) filled up and everything froze. The fix was non-blocking writes: a slow or missing reader must never stop you from draining your input.
- Boot-time `PATH`: boot scripts don't inherit your shell's `PATH`. A bare `python3` failed on every boot. Use absolute paths.

## Limits

- Decode stays in software; I haven't found a fix.
- Some incompatible files fall back to software.
- Everything depends on one physical phone staying on.
- I only tested concurrency with two sessions.
- 4K and HDR are only partly tested.
- I have not measured power draw or temperature during a transcode.

## How to try it

The pattern works for any "Jellyfin in Docker with an encoder the container can't reach". Swapping the encoder names in the wrapper might cover, for example, a VAAPI device the container can't see (I have not tried it).

1. On the host, install an ffmpeg with MediaCodec and copy `wrapper-ffmpeg.sh` and `bridge-daemon.py`.
2. Set `BRIDGE_BIND_ADDR`, `BRIDGE_PORT`, `BRIDGE_MEDIA_HOST_PATH`, `BRIDGE_CONFIG_HOST_PATH`, `BRIDGE_CACHE_HOST_PATH`, `BRIDGE_WRAPPER_PATH` and `REAL_FFMPEG`, and launch the daemon with `run-daemon-resilient.sh`.
3. Put `bridge-client.pl` in the Jellyfin image (or mount it) and point `--ffmpeg` at it.
4. Restart the container.

Code and full write-up: [jellyfin-hwaccel-bridge](https://github.com/parziva-1/jellyfin-hwaccel-bridge). Part 3, on mounting remote storage in Docker, is next: [`s21fe-rclone-teldrive-docker`](/en/posts/s21fe-rclone-teldrive-docker/).
