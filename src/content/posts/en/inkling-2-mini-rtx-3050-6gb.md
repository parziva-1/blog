---
title: "Inkling 2 Mini on a laptop RTX 3050: 19 tok/s generation, 40 tok/s prefill"
description: "Inkling 2 Mini (26.4B looped MoE) on a 6 GB RTX 3050 Laptop with llama.cpp: which experts to keep on GPU, why op offload doesn't fit, the prefill ceiling, the expert cache, DSpark and how it compares with Qwen3.6-35B-A3B."
pubDate: 2026-11-24T21:30:00-05:00
tags: [llm, llama.cpp, linux, benchmark]
category: ia
draft: false
lang: en
translationKey: inkling-2-mini-rtx-3050-6gb
metric:
  value: "19 tok/s"
  label: "Inkling 2 Mini generation on 6 GB of laptop VRAM"
specs:
  - { label: "Laptop", value: "Lenovo IdeaPad Gaming 3" }
  - { label: "CPU", value: "Ryzen 5 7535HS (6c/12t)" }
  - { label: "GPU", value: "RTX 3050 Laptop, 6 GB VRAM, PCIe 4.0 x8" }
  - { label: "RAM", value: "32 GB DDR5-4800" }
  - { label: "Model", value: "Inkling 2 Mini, Unsloth UD-Q3_K_XL (12.7 GiB)" }
  - { label: "llama.cpp", value: "b12697 and b12703, CUDA" }
---

Inkling 2 Mini (Thinking Machines, Nov 20) shipped with the pitch of "a 26B-class model in 4 GB of VRAM". I ran it on a **6 GB RTX 3050 Laptop**, the same GPU as the [Flint 40B](/en/posts/flint-40b-moe-6gb-vram/) and [LFM3-1.7B](/en/posts/lfm3-1-7b-200k-rtx-3050/) posts, which is also the desktop's primary GPU.

## Summary

- **Generation: 18-19 tok/s** with the experts of 7-8 loop layers on the GPU. All on CPU: 12.7.
- **Prefill: ~40 tok/s, and there is no way to raise it on 6 GB.** Op offload asks for 2.9 to 8.2 GB of extra VRAM with this model.
- **Prompt caching works**: a second message with the same prefix reuses 2381 of 2385 tokens. In a chat, only the first message pays for prefill.
- **DSpark (speculative decoding) doesn't load yet** on any released llama.cpp build.
- **On this GPU, Qwen3.6-35B-A3B wins**: pp 400-557 and tg 32-34 with MTP.

## The model

26.4B MoE, 128 experts with 8 active (3.4B active per pass). Its defining trait: **layers 6-17 run three times per token** with shared weights, each pass with its own cache. That changes how to split it between GPU and CPU.

GGUF: [Unsloth UD-Q3_K_XL](https://huggingface.co/unsloth/Inkling-2-Mini-GGUF) (13.6 GB), the smallest of the quants recommended for 6-8 GB. Support has been in llama.cpp since [#32694](https://github.com/ggml-org/llama.cpp/pull/32694).

## Which experts go on the GPU

The idea comes from [@analogalok](https://x.com/analogalok), who got 22 tok/s on an 8 GB RTX 4060: instead of `--n-cpu-moe`, which sends the first N layers to CPU, use `-ot` to keep the experts of the loop layers (used 3 times per token) on the GPU and send the outer layers' experts to CPU. The whole loop doesn't fit in 6 GB, so I swept how many layers do.

`llama-bench`, b12697, `-ngl 99 -fa on -ctk q8_0 -ctv q8_0 -t 6 -lm none -nopo 1`:

| Experts on GPU | `-ub` | pp512 (tok/s) | tg128 (tok/s) |
|---|---|---|---|
| none (`-ncmoe 24`) | 64 | 24.8 | 12.7 |
| loop 6-11 | 64 | 41.2 | 18.0 |
| loop 6-11 | 256 | 46.7 | 18.0 |
| loop 6-12 | 64 | 43.0 | 18.6 |
| loop 6-12 | 256 | 45.6 | 18.7 |
| **loop 6-13** | **64** | **47.8** | **19.4** |
| loop 6-14 | — | doesn't load (6.1 GB of weights on GPU) | — |

`-ot` pattern (here, loop 6-12 on GPU):

```
-ot "blk\.([0-5]|13|14|15|16|17|1[89]|2[0-3])\.ffn_.*_exps.*=CPU"
```

`llama-server` needs a bit more VRAM than `llama-bench`: at 16k context, **6-13 doesn't start and 6-12 does** (5.4 GB). Final config:

```
llama-server -m Inkling-2-Mini-UD-Q3_K_XL.gguf --jinja -c 16384 -np 1 \
  -ngl 99 -fit off -fa on -ctk q8_0 -ctv q8_0 -t 6 -tb 12 -lm none \
  --no-op-offload -ub 64 \
  -ot "blk\.([0-5]|13|14|15|16|17|1[89]|2[0-3])\.ffn_.*_exps.*=CPU"
```

Generating 700 tokens: **18.4 tok/s**. `-fit off` is needed for the manual split to stick; `llama-server`'s auto-fit aborts with a fixed `-ngl`.

## Why prefill doesn't go up

With op offload (the default), llama.cpp copies CPU-resident expert weights to the GPU to process the prompt in batches. For regular MoEs it copies only the selected experts. **For Inkling it copies the whole tensor**, all 128 experts, because each loop pass can pick different experts from the same copy. It's a TODO in `src/llama-context.cpp` (`sched_copy_experts`, see [#32807](https://github.com/ggml-org/llama.cpp/pull/32807)).

The compute buffer blows up:

| Config (op offload on) | CUDA buffer requested |
|---|---|
| loop 6-12 on GPU, `-ub 64` | 2.9 GB |
| loop 6-9 on GPU, `-ub 512` | 4.6 GB |
| loop 6-8 on GPU, `-ub 1024` | 5.5 GB |
| no experts on GPU, `-ub 512` | 6.8 GB |
| no experts on GPU, `-ub 2048` | 7.7 GB |
| `-cmoe` + `--moe-cache-mib 2000`, `-ub 512` | 8.2 GB |

None of that fits in 6 GB, so **`--no-op-offload` is mandatory** and the CPU processes the prompt: 6 Zen 3 cores give ~40 tok/s. With a real 2385-token prompt on `llama-server` (b12703), **38 tok/s**.

The GPU expert cache (`--moe-cache-mib`) only starts together with `--no-op-offload`, and it's worse that way: with 2000 MiB, pp 27 and tg 10.0.

## What does help: prompt caching

Same 2385-token prompt sent twice to the same slot: the second time `llama-server` reuses 2381 tokens and processes 4. The loop's own caches and the convolution state don't break prefix reuse.

In practice, the first message of a conversation with a long system prompt (a client with 30+ MCP tools sends ~11k tokens) takes ~4-5 minutes to start. The following ones start almost immediately.

## DSpark

Unsloth ships a DSpark draft (`dspark-Inkling-2-Mini-Q8_0.gguf`, 0.5 GB) for speculative decoding. It doesn't load on b12703: `joint_proj.weight` is 5120×768 and the code expects 2816×768. The matching support ([#32218](https://github.com/ggml-org/llama.cpp/pull/32218)) is on `master` but in no release tag yet. The `_Old` file doesn't work either: its vocabulary is 201,024 tokens and the model uses 200,058. Worth retesting once a tag includes #32218.

## Versus Qwen3.6-35B-A3B on the same GPU

| | Inkling 2 Mini (UD-Q3_K_XL) | Qwen3.6-35B-A3B (Q4_K + MTP) |
|---|---|---|
| Prefill | ~40 tok/s | 400-557 tok/s |
| Generation | 18-19 tok/s | 32-34 tok/s |
| VRAM | 5.4 GB | ~3.9 GB |

Qwen3.6 uses op offload without trouble and has MTP in llama.cpp. Inkling's model card also warns that quality drops outside English; in Spanish it handled a 700-token technical explanation fine, but I didn't run a quality evaluation.

## Conclusions

- On a **6 GB RTX 3050 Laptop**, Inkling 2 Mini runs at **18-19 tok/s**, but ~40 tok/s prefill limits it to short prompts or chats where prompt caching amortizes the first message.
- The limit isn't the GPU but how llama.cpp currently does op offload for this model. If the copy-only-the-used-experts TODO gets solved, or the attention-mask buffer shrinks, prefill could jump.
- **For this laptop, Qwen3.6-35B-A3B is still the best local option.** Inkling is worth retesting once DSpark lands in a release.
