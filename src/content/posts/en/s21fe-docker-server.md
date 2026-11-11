---
title: "A Galaxy S21 FE as a 24/7 server with native Docker"
description: "Root, an Android 13 GSI and a custom kernel to run Docker straight on a phone, no virtual machine. What works and what doesn't, tested on the device."
pubDate: 2026-11-11T08:04:00-05:00
tags: [android, docker, homelab, kernel]
category: android
draft: false
lang: en
translationKey: s21fe-docker-server
repo: https://github.com/parziva-1/Proton
metric:
  value: "8 cores"
  label: "and 8 GB of RAM serving containers 24/7"
specs:
  - { label: "Phone", value: "Samsung Galaxy S21 FE (SM-G990E, Exynos 2100)" }
  - { label: "Android", value: "13, phh-treble GSI arm64" }
  - { label: "Kernel", value: "5.4.302 ProtonPlus v6.1.1 (own fork)" }
  - { label: "Root", value: "Magisk 27" }
  - { label: "Docker", value: "24.0.6 native, overlay2, no virtual machine" }
  - { label: "Data", value: "dedicated ext4" }
---

This is part one of the series "A phone as a server": how I turned a Galaxy S21 FE I had lying around into a container server that runs around the clock, with Docker straight on the phone's kernel. No virtual machines, no chroot: the containers use the same kernel as Android.

The other parts:

- [Part 2: Jellyfin with hardware video encoding](/en/posts/s21fe-jellyfin-hw-transcoding/)
- [Part 3: rclone + teldrive as storage for Docker](/en/posts/s21fe-rclone-teldrive-docker/)
- [Part 4: keeping Android from killing the server](/en/posts/s21fe-keep-android-alive/)

Everything I say here I checked on the phone while writing, not from memory.

## Why a phone

- I already had it. A high-end phone from a few years ago has 8 ARM cores and 8 GB of RAM. For a home server that's plenty.
- It draws very little. Most of the time the CPU is idle (on November 11, 2026 I measured 95 % idle with five containers running).
- The battery is a UPS (a backup battery). If the power goes out, the server keeps going for a good while.

And the downside, so nobody gets a surprise: a phone is not a server. Android is built to save battery and kill processes, and a big part of the work is convincing it not to. That's what part 4 is about.

## Before you start: what you lose

> [!WARNING]
> - Knox is gone for good. Unlocking the bootloader (the program that boots the system) blows a physical fuse, the "warranty bit". There's no going back: goodbye warranty, Samsung Pay, Secure Folder and anything that depends on Knox. On my unit the kernel reports it like this: `androidboot.warranty_bit=1`.
> - The phone warns you on every boot. With the bootloader unlocked, a warning screen shows up at power-on. Android calls this boot state "orange": the system boots even though it isn't signed by Samsung. It's normal and can't be removed.
> - Unlocking the bootloader wipes the whole phone. Back up first.
> - You can brick it if you flash the wrong partition or a kernel that doesn't boot. Save copies of `boot`, `vendor_boot` and `dtbo` before touching anything.
> - Security drops. With root, SELinux (Android's mandatory access control) in permissive mode and a modified kernel, this device must not hold anything sensitive or be used as your main phone. I keep no bank accounts or anything personal on it.
> - All of this is for the SM-G990E (Exynos). It doesn't apply to the Snapdragon versions.

## What you need

- A Galaxy S21 FE with Exynos 2100.
- A PC with `adb` and `fastboot` (or Odin/Heimdall for Samsung's download mode) and a good USB cable.
- The OrangeFox recovery for the S21 FE.
- A phh-treble GSI with Android 13 for arm64.
- Magisk (I use version 27).
- A kernel with what Docker needs. Mine is at [parziva-1/Proton](https://github.com/parziva-1/Proton).
- Termux and the `docker` package from its root repository (it installs `dockerd`, `containerd`, `runc` and the client).
- A separate ext4 space for Docker's data. Android's data partition uses its own layout and encryption, and it's best not to mix them.

## The steps, in broad strokes

This is not a step-by-step tutorial: for each point there are better guides on the S21 FE forum on XDA, and I link them at the end. What I do include is how I check that each stage worked.

### 1. Bootloader and recovery

You enable OEM unlock in developer options, unlock from download mode and flash OrangeFox. On Samsung you also have to flash a `vbmeta` with verification disabled; without it, the phone won't boot either the GSI or a custom kernel. The recovery is the tool you'll use most afterwards: for backups, for flashing the GSI and for switching kernels.

To check: boot into OrangeFox and confirm it mounts and decrypts the data.

### 2. Android 13 GSI

A GSI is a generic Android image that works on many phones. I use phh-treble, Android 13, arm64. You flash it from OrangeFox and wipe the data.

```bash
adb shell getprop ro.build.version.release   # 13
```

### 3. Root with Magisk

You patch the boot image with the Magisk app and flash it. I keep the app hidden (Magisk lets you rename its package).

```bash
adb shell su -c id   # uid=0(root)
```

One confusing detail: with Magisk, `getprop` may say the bootloader is locked and verified even though it isn't, because Magisk rewrites those properties. The truth is in the kernel command line:

```bash
su -c "tr ' ' '\n' < /proc/cmdline | grep -E 'warranty_bit|verifiedbootstate'"
# androidboot.warranty_bit=1
# androidboot.verifiedbootstate=orange
```

### 4. A kernel that works for Docker

This is the real work. I start from Proton+ for the Exynos 2100 (by ProtonKernel and EliteGalaxy) and keep a fork with what Docker asks for, using the Moby project's `check-config.sh` script and FreddieOliveira's guide as the checklist.

What I enabled on top of the original config:

| What for | Options |
|---|---|
| Process isolation | `PID_NS`, `USER_NS`, `IPC_NS`, `SYSVIPC`, `POSIX_MQUEUE` |
| Control groups (cgroups) | `CGROUP_PIDS`, `CGROUP_DEVICE`, `CFS_BANDWIDTH`, `BLK_DEV_THROTTLING`, `CPUSETS` |
| Docker networking | `BRIDGE_NETFILTER`, `NETFILTER_XT_MATCH_ADDRTYPE`, `NETFILTER_XT_MATCH_IPVS`, `MACVLAN`, `IPVLAN` |
| NAT for IPv6 | `IP6_NF_NAT`, `IP6_NF_TARGET_MASQUERADE` |

The kernel is built on GitHub Actions in three variants (`full`, `safe` and `base`), so there's always one that boots if another fails, and it's packaged in AnyKernel3 format to flash from OrangeFox. I also tried to bring in a more modern eBPF, but it broke the build and I dropped it.

> [!NOTE]
> Don't trust `/proc/config.gz` on this kernel. Mine reports `PID_NS` and `CGROUP_PIDS` as disabled, but the kernel does have them: a container sees its own PID 1, `/proc/self/ns/pid` and `/proc/self/ns/user` exist, and `/proc/cgroups` lists `pids`. The embedded config drifted from the one that was actually compiled. To know what's really there, test it directly on the device:

```bash
uname -r                                   # 5.4.302-ProtonPlus-v6.1.1
ls /proc/self/ns                           # cgroup ipc mnt net pid ... user uts
awk 'NR>1{print $1, $4}' /proc/cgroups     # each controller and whether it's enabled
ip link add t0 type dummy && ip link add t1 link t0 type macvlan && echo macvlan-ok
ip link del t1; ip link del t0
```

### 5. Docker

I install the `docker` package from Termux's root repository (client 24.0.6, containerd 1.6, runc 1.5) and launch `dockerd` as root. The data goes on the dedicated ext4 space, with the `overlay2` driver.

```bash
docker info --format '{{.Driver}} cgroup v{{.CgroupVersion}}'   # overlay2 cgroup v2
docker run --rm alpine sh -c 'echo $$'                             # 1
```

Autostart is handled by a supervisor script that I launch from Termux:Boot at power-on. That supervisor is what keeps everything else alive, and I cover it in part 4.

## What works and what doesn't

I ran the limit and networking tests on November 11, 2026 with disposable containers; they aren't from old notes. "Running for months on end" is a different thing: it's how long the services have been in real use on the device.

Works:

- Custom bridge networks, port publishing and NAT. At first I could only use `--network host`; with this kernel my services now run on their own bridge network.
- macvlan and ipvlan interfaces, and the IPv6 NAT table.
- Process isolation: inside the container, the first process is PID 1.
- `overlay2` on ext4.
- A media server, its database and other services running for months on end.

Doesn't work:

> [!FAIL]
> - `--memory` and `--pids-limit` are ignored. Docker warns ("Limitation discarded") and carries on. A 150 MB process inside a container limited to 64 MB lived without any trouble.
> - `--cpus` errors out, and `--cpuset-cpus` and `--cpu-shares` are dropped with a warning.
> - `docker stats` shows zeros.

The odd part is that the kernel does support those limits: `/proc/cgroups` has `memory`, `cpu`, `pids` and `cpuset` enabled, and `cpu.cfs_quota_us` exists. The problem is Android: it mounts its cgroups v1 separately (in `/dev/memcg`, `/dev/cpuctl`, `/dev/cpuset`...) and also mounts a cgroup v2 at `/sys/fs/cgroup` with no controllers at all. Docker sees the v2, finds nothing and drops the limits. With `cpuset` there's an extra clash: Android mounts it with the `noprefix` option (files named `cpus` instead of `cpuset.cpus`) and Docker expects the opposite.

You could try giving `dockerd` its own mount namespace with cgroups v1 laid out the way it likes, but I haven't done it: messing with how Android mounts its cgroups can break how it prioritizes apps. In the meantime I look after RAM with a guard of my own (part 4). The practical conclusion: here a runaway container can eat the whole phone, so you have to watch it from the outside.

### Other things worth knowing

Heat is the real limit. There's no fan. At idle the cores sit between 43 and 56 °C. With all 8 cores at 100 % it reaches 82-85 °C in 15 seconds, and by 45 seconds the big cores have already dropped from ~2 GHz to ~1 GHz to cool down. Twenty seconds after the load stops it's back to ~47 °C. Fine for bursty loads, not for compiling for hours.

The kernel has no CIFS or NFS, so to mount network drives I use rclone in userspace, with the speed cost that implies. Part 3 is about that.

The load average lies. On Android it climbs to absurd values because of kernel threads and FUSE mounts waiting on I/O, even when the CPU is idle. Look at the idle percentage and per-process usage.

The first boot with the new kernel is scary. `dockerd` took several minutes because `containerd` had to clean up old orphaned processes, and my supervisor killed it before it finished. Raising its timeout from 60 to 240 seconds fixed it.

## Credits

None of this is mine from scratch:

- ProtonKernel / Proton+ and EliteGalaxy, for the base kernel for the Exynos 2100.
- TurboRCT, for OrangeFox for the S21 FE.
- phh, for the phh-treble GSIs.
- FreddieOliveira, for the native Docker on Android guide, which was my direct reference.
- The S21 FE community on the XDA forum, for the root, recovery, GSI and `vbmeta` guides.
- Magisk, Termux and the Moby project.

## Links

- My kernel fork: [parziva-1/Proton](https://github.com/parziva-1/Proton) (branch `proton-main`)
- Original kernel: [ProtonKernel/Proton](https://github.com/ProtonKernel/Proton)
- Proton+ thread on XDA: [Proton Kernel for Exynos 2100](https://xdaforums.com/t/kernel-exynos2100-proton-kernel.4700246/)
- S21 FE forum on XDA: [Samsung Galaxy S21 FE](https://xdaforums.com/f/samsung-galaxy-s21-fe.12389/)
- Native Docker on Android guide: [FreddieOliveira's gist](https://gist.github.com/FreddieOliveira/efe850df7ff3951cb62d74bd770dce27)
