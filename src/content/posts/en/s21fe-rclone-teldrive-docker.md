---
title: "Big storage on a phone: rclone + teldrive in Docker"
description: "How I mount teldrive with rclone (FUSE) on a rooted phone and pass it into Docker containers: mount-master, bind mounts, VFS cache and the anti-ban rule."
pubDate: 2026-11-11T08:02:00-05:00
tags: [android, docker, homelab, rclone, teldrive]
category: homelab
draft: false
lang: en
translationKey: s21fe-rclone-teldrive-docker
specs:
  - { label: "Backend", value: "teldrive (open source) + PostgreSQL" }
  - { label: "Mount", value: "rclone with the teldrive backend, FUSE" }
  - { label: "VFS cache", value: "full mode, 10 GB, 24 h" }
  - { label: "Rate limit", value: "rate-limit=true, rate=50, rate-burst=3" }
---

Part three of the "A phone as a server" series. After [root, kernel and Docker](/en/posts/s21fe-docker-server/) and [hardware transcoding](/en/posts/s21fe-jellyfin-hw-transcoding/), it's storage time: using teldrive as big, cheap storage, mounting it with rclone on the phone and handing it to containers.

## Why teldrive

Phone storage is small and server storage costs money. [teldrive](https://github.com/tgdrive/teldrive) is an open-source project that stores files on Telegram and exposes them as a drive with an API. The appeal is practical: huge capacity for almost nothing.

The catch, plainly: it's a clever hack, not a service with guarantees. Speed depends on the network and on request limits, and there is one rule you must never break (see "The anti-ban rule"). Don't put anything there you can't get back.

## The architecture

Three pieces:

1. The teldrive server and its PostgreSQL, on a machine the phone can reach. The database is the source of truth: a stale local copy shows you a world that no longer exists. I won't cover where it runs.
2. rclone on the phone, using a build that includes the `teldrive` backend. The stock Termux rclone doesn't ship it, so I use a separate build with that backend. It mounts the remote as a folder via FUSE.
3. Docker containers that bind-mount that folder. In my case, a media server and a tool that organizes files.

```
teldrive + PostgreSQL  <--HTTP-->  rclone (FUSE)  --bind-->  containers
```

## The mount on Android

This is where I lost the most time, and almost all of it is Android, not rclone.

### FUSE and the mount namespace

The kernel needs FUSE (mine has it, see part 1). But Android uses per-process mount namespaces: what you mount in a normal `su` session is invisible to everyone else, including `dockerd`. The fix is `su -M` (mount-master): the command runs in the global namespace, so the Docker daemon sees the mount.

```bash
su -M -c 'rclone mount ...'
```

Mount with plain `su` and the mount "exists" for you while containers see an empty folder. I hit this more than once before understanding it.

### An example command

This is what mine looked like on November 11, 2026, minus the paths:

```bash
rclone mount teldrive: /path/to/mountpoint \
  --vfs-cache-mode full \
  --vfs-cache-max-size 10G \
  --vfs-cache-max-age 24h \
  --buffer-size 64M \
  --dir-cache-time 6h \
  --poll-interval 1h \
  --attr-timeout 1m \
  --rc --rc-addr 127.0.0.1:<port>
```

What mattered:

- Read-write, carefully. My teldrive mount is read-write because a tool organizes files there. That carries risks I explain in the corruption section. If your containers only read, add `--read-only`: it's the cheapest way to prevent accidents. (Another mount I have, to a network drive, is read-only.)
- `--dir-cache-time 6h`: avoids listing the remote on every `ls`. A media library scan would do hundreds of listings. The price: if you delete or change something on the server, the phone can take up to 6 hours to notice.
- `--vfs-cache-mode full` with 10 GB and 24 hours: what you read stays on local disk. With a warm cache I read at ~80-110 MB/s, limited by the phone's flash; uncached, ~8 MB/s. That's the difference between a video that starts and one that stalls.
- `--rc` listening only on `127.0.0.1`: enables rclone's remote control so you can query VFS stats and forget cached paths without remounting. Never expose it to the network: with no authentication, anyone could drive your mount.

In my measurements rclone isn't the bottleneck: ~57 MB of RAM and almost no CPU.

### Bind-mount propagation

This is the trap that surprises people. A container with a bind mount to a FUSE folder keeps the mount as it was when the container was created. If rclone dies and is remounted, the container still points at the old mount: it sees an empty folder or "Transport endpoint is not connected".

My supervisor (a 30-second loop) handles it in two steps:

1. If the mount is missing, remount it.
2. For each container that uses the mount, run an `ls` inside it. If the listing comes back empty, the bind is broken, and it recreates the container.

Recreating is the only thing that works reliably. Alternatives such as a deferred (lazy) unmount (`umount -l`) don't help: the old rclone keeps serving the container's bind. A new option isn't applied automatically either: the supervisor only mounts when nothing is mounted, so to change an rclone option you kill the process, wait for the supervisor to remount with the updated command, and let it recreate the containers.

> [!NOTE]
> Containers that read the mount must be safe to recreate: their config and data live in separate volumes, not inside the container.

## The anti-ban rule

Telegram limits request rates. Go over and you get forced waits (flood waits: Telegram telling you to wait before asking again) and, in the worst case, restrictions on the account that holds all your storage.

Teldrive ships its own limiter. My config, and I wouldn't change it for anything:

```toml
rate-limit = true
rate = 50
rate-burst = 3
```

> [!WARNING]
> Never set `rate-limit=false`. That limiter is a ceiling that protects you: with it in place you can afford more download concurrency, because it greatly lowers the risk of exceeding the limit (a local limiter can't guarantee anything against Telegram, but it helps a lot). Without it, a runaway library scan can cost you the account. After any heavy job, check the server logs for flood waits, using a tool that hides names.

## Corruption: `parts.mismatch`

Teldrive splits files into parts. Sometimes a file ends up with parts that don't match what's expected, and the server answers with a `parts.mismatch` error. From the outside: the media server loops on reads, the video stalls or won't open.

What I learned:

- Don't trust an earlier list of corrupt files. Once my old list called many healthy files broken. Verify again: ask the server for the start and the end of the file with range requests. A healthy file returns the bytes you asked for; a corrupt one returns a tiny error body. Check start and end, because the damage can sit in later parts.
- A timeout isn't corruption. With the server congested, some reads fail and succeed on retry.
- Don't probe corrupt files aggressively: reading one can crash the teldrive server.
- Soft delete doesn't delete. My first deletion only marked files as pending deletion, and the server kept serving them if you knew their id. Check how purging works.
- After deleting, refresh the phone's cache (or wait for `dir-cache-time` to expire); otherwise the media server keeps seeing files that no longer exist. Killing the rclone process and letting the supervisor remount and recreate the containers is what worked for me.

### Overwriting on top of a VFS is dangerous

I learned this rule the hard way. A script of mine copied a frequently updated file with `cp -f`, i.e. overwriting in place on a writable mount. On rclone's VFS, overwriting truncates and rewrites the same object, and can leave the previous id stuck in the write queue. Result: tens of thousands of "record not found" errors per day until I cleared the queue by hand. It happened again a few hours later because the script hadn't changed.

The rule: never overwrite in place on an rclone VFS mount. Delete, then copy (or write a new file and rename).

And its cousin: moving files by hand without a proper VFS refresh can delete the data. If the destination resolves to the same id as the source, deleting one takes everything with it, and the server's periodic cleanup finishes the job. To move things I always use a tool that does the refresh, never a bare `mv` or `rclone move`.

## What I'd do differently

- Read-only mount where possible. Mine is read-write (so a tool can organize files) and that's where the problems above came from. If you can, write through teldrive's API on a separate path and keep the mount for reading only.
- Test the supervisor against a deliberately broken mount on day one, not when it breaks on its own.
- I can't tell you this lasts years. I've run it for months and it works. I have no more data than that.

Next and last part: stopping Android from killing all this, in [Keeping Android awake](/en/posts/s21fe-keep-android-alive/).
