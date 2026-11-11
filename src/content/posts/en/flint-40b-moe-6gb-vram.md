---
title: "A 40B MoE at 120k context on a laptop with 6 GB of VRAM"
description: "How I got a 40B MoE model (2.5B active) running at 120k context on a laptop with a 6 GB RTX 3050, which settings mattered, and what didn't work."
pubDate: 2026-11-11T08:10:00-05:00
tags: [llm, llama.cpp, linux]
category: ia
draft: false
lang: en
translationKey: flint-40b-moe-6gb
metric:
  value: "22 tok/s"
  label: "generation at 32k on 6 GB"
specs:
  - { label: "Laptop", value: "Lenovo" }
  - { label: "CPU", value: "Ryzen 5 7535HS" }
  - { label: "GPU", value: "RTX 3050, 6 GB VRAM" }
  - { label: "RAM", value: "32 GB" }
  - { label: "Model", value: "40B MoE (2.5B active), Mix-12G (~2.27 bpw experts)" }
  - { label: "Context", value: "122880 tokens" }
---

I wanted a local model for coding with a long context (reading a whole repository, not just one file) on the laptop I use every day. Here is what I measured, what worked and what didn't.

## The problem

The machine is a Lenovo laptop with a Ryzen 5 7535HS, an RTX 3050 with 6 GB and 32 GB of RAM, running CachyOS. Six gigabytes of VRAM (the graphics card's memory) are not enough for a decent dense model, let alone for 100k tokens of context. RAM is enough, but if the model is dense, the CPU can't keep up.

## Why a MoE

A Mixture of Experts (MoE) model has many parameters but activates only a few per token. Here I use a model with 40B parameters in total and 2.5B active. That lets me split the work: attention and the KV cache (the memory of the context) go on the GPU, and the experts, which are almost all of the model's weight, stay in RAM. Each token only touches a few experts, so the CPU keeps up.

The model is an "abliterated" variant (without the refusals from the original training). The quantization that worked best for me is a roughly 12 GB mix (`Mix-12G`, experts at ~2.27 bits per weight), compared with the ~21 GB IQ4_XS I used before.

## The key

Four settings, in order of importance:

- `--n-cpu-moe N`: keeps the experts of the first N layers on the CPU. The lower N is, the more experts are on the GPU, until VRAM runs out. With 6 GB, N=44 is the most that fits; with N=40 it already runs out of memory (OOM).
- KV cache in `q4_0` (`-ctk q4_0 -ctv q4_0`): at 120k context the KV cache is what weighs the most. Going from q8 to q4_0 freed enough VRAM to put 4 more expert layers on the GPU (from n48 to n44).
- `-ub 2048`: big batches speed up prompt reading, because each trip of the experts over PCIe pays off more.
- Context of 122880 with `--cache-ram 2048 --no-context-shift`: fixed context, so the server doesn't drop old messages on its own.

Peak VRAM stays at ~5.3 GB, with ~0.75 GB of baseline from the desktop.

### Chrome was eating 3 GB

Before measuring I had to fix something unrelated: Chrome's local Gemini Nano was using close to 3 GB of VRAM. On 6 GB that is half. It is disabled with the enterprise policy `GenAILocalFoundationalModelSettings=1` (a JSON file in Chrome's managed policies directory). Without that, nothing that follows fits.

## Results

Everything at `-c 122880 --cache-ram 2048 --no-context-shift -ub 2048`, in tokens per second (pp = reading the prompt, tg = generating the reply):

| Config | Peak VRAM (MiB) | RAM (GB) | tg empty | 32k pp / tg | 100k pp / tg | 118k pp / tg |
|---|---|---|---|---|---|---|
| IQ4_XS, n48, KV q8 | 5323 | 21.4 | 34.4 | 619 / 22.3 | 456 / 11.4 | 346 / 11.7 |
| **Mix-12G, n44, KV q4_0** | 5342 | 11.3 | 33.6 | **875 / 22.4** | **606 / 13.3** | **490 / 11.8** |

There are two things worth highlighting. The Mix wins on pp because it weighs half as much and pp is limited by PCIe. And RAM drops from 21 to 11 GB, which lets me use the laptop while the server runs. Reading 100k tokens takes about 3 minutes; later turns take between 5 and 20 seconds thanks to the prompt cache.

The numbers come from a single machine and few runs, so take them as a reference, not as gospel. (The IQ4_XS row is from an earlier measurement, with a different llama.cpp build; the Mix was measured with a more recent build that improved pp by 18-25 % without changing tg.)

## Quality

When quantizing the experts to ~2.3 bits I was worried quality would drop. In my tests there was none:

- A Go function with 16 hidden assertions, 3 samples: 3/3 (same as IQ4_XS).
- Long context (~109k tokens), 5 retrieval questions: 5/5.
- A coding agent fixing 4 bugs in Go, 2 runs: 2/2, faster than with IQ4_XS.

These are small tests and not a serious benchmark, but they cover my real use.

## What didn't work

> [!FAIL]
> - `--moe-cache-mib` (an expert cache in VRAM): on 6 GB it takes memory away from the compute buffer and makes everything worse. With 400 MiB, pp at 32k drops from 875 to 823 and tg from 22.4 to 20.5. With 600 MiB, out of memory.
> - KV in f16: out of memory, with n48 and with n54.
> - KV q8 with the Mix at n44 and q4_0 with n40: out of memory. The margin is one or two layers.
> - Lowering `--n-cpu-moe` beyond what fits barely raises tg, because it is not the limit.

## Why

My read is that generation (tg) is limited by the CPU, not by bandwidth: the IQ1/IQ2 quantization types cost more to decompress on Zen 3+ without AVX-512, so with the same KV config (q8) the Mix generates a bit slower than IQ4_XS. That is my interpretation; I haven't confirmed it with a profiler. With the prompt the opposite happens: pp is limited by PCIe Gen4 x8, because the experts are uploaded to the GPU on every ubatch, and a model that weighs half as much benefits directly. With the final config (KV q4_0 plus four more expert layers on the GPU), generation matches IQ4_XS at 32k and is faster at 100k, so it makes up for the more expensive decompression.

## The final command

```bash
llama-server -m Flint-abliterated-Mix-12G.gguf \
  -c 122880 --n-cpu-moe 44 -ub 2048 \
  --cache-ram 2048 --no-context-shift \
  -ctk q4_0 -ctv q4_0 \
  -ngl 99 -fa on --jinja -t 6 -fit off \
  --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0 \
  --host 127.0.0.1 --port 8091
```

I launch it as a systemd user service with a memory cap (`MemoryMax=24G`), because an uncapped benchmark once froze the machine on me.

## What I'd do with more VRAM

With 8 GB the improvement would be small: most of the experts would still be on the CPU, which is the bottleneck. With 12 GB more than half the model would fit and generation should go up quite a bit. The big jump is at **16 GB**: there this 12 GB model fits entirely on the GPU next to the 120k context in q4, and the CPU stops being the limit. So if I ever build a separate server for this, the card has to be 16 GB or more, not 8.
