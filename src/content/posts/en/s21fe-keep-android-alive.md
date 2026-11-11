---
title: "How I stop Android from killing my home server"
description: "A rooted Galaxy S21 FE as a 24/7 server: the Termux freezer, SELinux on sshd, a Wi-Fi that drops big packets, supervisor, RAM, battery and measured thermals."
pubDate: 2026-11-11T08:01:00-05:00
tags: [android, homelab, termux, magisk]
category: android
draft: false
lang: en
translationKey: s21fe-keep-android-alive
specs:
  - { label: "Phone", value: "Samsung Galaxy S21 FE (SM-G990E)" }
  - { label: "Boot", value: "Termux:Boot (supervisor and sshd) + Magisk service.d (ADB over Wi-Fi)" }
  - { label: "Charge cap", value: "70 %" }
  - { label: "Thermals", value: "idle 43-56 °C, full load 82-85 °C" }
---

This is part four of the series "A phone as a server". In the [first part](/en/posts/s21fe-docker-server/) I got Docker running on a rooted Galaxy S21 FE. This post covers what comes next and what few people mention: Android is designed to save battery and kill processes, and a server needs exactly the opposite. Almost everything below came from a real failure.

## The cached apps freezer

The first symptom was strange: the SSH port accepted connections, but the session hung at the banner. It wasn't RAM and sshd wasn't broken. Android had frozen the Termux app (its "cached apps freezer") because the Termux service lost foreground status, and the sshd living inside it froze too.

To diagnose it, look at which kernel function the process is sleeping in:

```bash
cat /proc/$(pidof sshd)/wchan
# do_freezer_trap  -> frozen by Android
```

The immediate fix, without killing anything, is to ask the Termux service to hold a wakelock (a lock that stops the system from putting it to sleep):

```bash
am startservice --user 0 \
  -n com.termux/com.termux.app.TermuxService \
  -a com.termux.service_wake_lock
```

The permanent fix is my supervisor doing it every cycle: if the service isn't in the foreground, it re-acquires the wakelock and writes a line to its log.

## sshd: launch it right or lose DNS

If sshd dies, you have to relaunch it, and how matters. My old method was `su <termux-uid> -c sshd`. It works, but the process ends up with Magisk's SELinux context instead of a normal app's, and Android's DNS rejects that context (SELinux contexts are the security labels Android uses to decide what a process may do). The result: you can SSH in, but inside the session there is no DNS (`pkg update` says no mirror is reachable).

The right way is to ask Termux itself, through its `RunCommandService`:

```bash
am startservice --user 0 \
  -n com.termux/com.termux.app.RunCommandService \
  -a com.termux.RUN_COMMAND \
  --es com.termux.RUN_COMMAND_PATH "$PREFIX/bin/sshd" \
  --ez com.termux.RUN_COMMAND_BACKGROUND true
```

Run it as the Termux user, not as root: as root it fails for lack of the `RUN_COMMAND` permission. Then check the context:

```bash
cat /proc/$(pidof sshd)/attr/current
# should say untrusted_app..., not magisk
```

At power-on, a Termux:Boot script starts sshd the right way. If it dies later, I relaunch it the same way, never with `su`.

## A Wi-Fi that drops large packets

One day SSH hung during key exchange, from every machine. The phone's Wi-Fi was dropping packets larger than about 1200 bytes. The test is a ping that forbids fragmentation:

```bash
ping -M do -s 1300 <phone-ip>   # fails
ping -M do -s 1172 <phone-ip>   # passes
```

With small packets everything looks healthy (ping, TCP connect), which is why this is hard to spot. Reconnecting Wi-Fi fixes it (`cmd wifi set-wifi-enabled disabled`, then `enabled`), so now a network watchdog runs the same test against the gateway every cycle with 1400 bytes. After three failures in a row, with the local network otherwise up, it reconnects Wi-Fi, at most once every 30 minutes.

Two more watchdog rules, learned from other outages: it only bounces Wi-Fi when the gateway fails (never because the internet is down), and after toggling it forces a scan with `cmd wifi start-scan`. Without that, after a long power cut the phone sat for 11 hours without re-associating.

## The supervisor

Everything above hangs off a shell loop that I start with Termux:Boot when the phone powers on. (I use Magisk's `service.d` folder only to keep ADB over Wi-Fi active, which is my rescue channel.) Every 30 seconds it checks:

- disk mounts,
- that `dockerd` is alive,
- the VPN daemon,
- FUSE mounts,
- the RAM guard,
- firewall rules,
- the Termux wakelock.

> [!NOTE]
> Editing the supervisor script doesn't change the running process: the loop is already loaded in memory. Relaunch it or wait for the next boot.

One failure I caused myself: after a kernel update, `dockerd` wouldn't come up. `containerd` had to clean up a huge pile of orphaned "shim" processes (small go-betweens between containerd and each container) accumulated over months, and my supervisor killed it every ~90 seconds before it finished. A self-inflicted livelock. Fix: raise the internal timeout from 60 to 240 seconds.

## RAM, load average and bloatware

On this setup Docker's memory limits (`--memory`) are silently ignored, so a runaway container can eat the phone. The real defense is a guard in the supervisor: if available memory drops below ~700 MB, it drops caches and restarts the biggest container.

And don't trust load average: on Android it climbs to 14-17 because of kernel threads and FUSE waiting on disk while the CPU is nearly idle. Look at `%idle` and per-process usage.

To free RAM I disabled about 45 packages (Play Store included) with `pm disable-user --user 0 <package>`, reversible with `pm enable --user 0 <package>`. Some, like Google's services, come back on their own, so I have to re-check.

> [!WARNING]
> Never run `pkg upgrade` blindly in Termux: it overwrites the hardened sshd config (key-only). Use `apt-get -o Dpkg::Options::=--force-confold upgrade` and relaunch sshd right after.

## Battery and thermals

A phone plugged in 24/7 is hard on its battery, so I cap charging at 70 % through the battery driver's `batt_full_capacity` knob.

I also run a logger that every 2 minutes records level, voltage, temperature, charge source (wall or USB) and thermal status into a CSV, trimmed to about 14 days. It doesn't alert; it only keeps data.

The reason is a real incident: the phone shut down while "plugged in". The boot reason said `shutdown,battery`, with the battery at about 58 %. Thermals were normal. It was charging from a laptop's USB-C port, not a wall charger. The first time, the cause was a loose cable on that port: I moved it to a wall charger and it was fixed. It has happened again since, with no confirmed cause, and I won't invent one. The logger exists so the next shutdown leaves data instead of just a boot message.

Temperatures I measured on November 11, 2026:

| Situation | Result |
|---|---|
| Idle | 43-56 °C |
| All 8 cores at 100 % | 82-85 °C within 15 s |
| Big cores under load | drop from ~2 GHz to ~1 GHz by 45 s |
| After releasing the load | ~47 °C after 20 s |

So the phone handles bursts, but sustained load slows it down (thermal throttling). For a home server that is mostly idle, that's acceptable.

## What I learned

A server on Android is not "install and forget". Every failure in this list (the freezer, sshd without DNS, the Wi-Fi that drops large packets, the `dockerd` livelock) showed up because the server stopped responding, and each ended as a permanent check in the supervisor, which re-checks everything every 30 seconds. If you build something similar, start with three things: the Termux wakelock, a large-packet ping against your gateway, and a battery and temperature log before you need it. The repeated shutdown is still without a cause, and I'll chase it with the logger's data.
