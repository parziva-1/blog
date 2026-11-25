---
title: "Inkling 2 Mini at 2 bits on a laptop RTX 3050: 27 tok/s and 440 tok/s prefill"
description: "With UD-IQ2_XXS the whole Inkling 2 Mini loop fits in 6 GB of VRAM and op offload becomes possible again: 27 tok/s generation and ~440 tok/s prefill on an RTX 3050 Laptop, plus a small quality check against Qwen3.6-35B-A3B."
pubDate: 2026-11-25T15:30:00-05:00
tags: [llm, llama.cpp, linux, benchmark]
category: ia
draft: false
lang: en
translationKey: inkling-2-mini-iq2-rtx-3050-6gb
metric:
  value: "440 tok/s"
  label: "Inkling 2 Mini prefill on 6 GB of laptop VRAM"
specs:
  - { label: "Laptop", value: "Lenovo IdeaPad Gaming 3" }
  - { label: "CPU", value: "Ryzen 5 7535HS (6c/12t)" }
  - { label: "GPU", value: "RTX 3050 Laptop, 6 GB VRAM, PCIe 4.0 x8" }
  - { label: "RAM", value: "32 GB DDR5-4800" }
  - { label: "Model", value: "Inkling 2 Mini, Unsloth UD-IQ2_XXS (8.5 GB)" }
  - { label: "llama.cpp", value: "Unsloth b12675-mix, CUDA" }
---

Part two of [Inkling 2 Mini on a laptop RTX 3050](/en/posts/inkling-2-mini-rtx-3050-6gb/). With UD-Q3_K_XL the ceiling was 48 tok/s prefill and 19.5 generation. Switching to Unsloth's 2-bit quant, on the same **6 GB RTX 3050 Laptop**, prefill goes up 9x.

## Summary

- **UD-IQ2_XXS (8.5 GB) lets the experts of the whole loop live on the GPU** (layers 6-17, the ones evaluated three times per token).
- **Generation: 27 tok/s**, vs 19.5 with UD-Q3_K_XL.
- **Prefill: ~440 tok/s**, vs 48. With the loop on the GPU, **op offload fits again** in 6 GB.
- **Quality**, on a small check of 8 verifiable questions: 7/8 (Qwen3.6: 8/8 given enough tokens). Inkling's miss was a made-up fact, not a reasoning error.
- **Versus Qwen3.6-35B-A3B** on the same GPU: Qwen still generates faster (32-34 tok/s), but Inkling answers sooner because it thinks much less.

## Why the quant changes so much

With UD-Q3_K_XL, the experts of 7 of the 12 loop layers fit on the GPU. The rest lived on the CPU, and op offload had to copy the full 128-expert tensor of each loop layer to the GPU (see [part one](/en/posts/inkling-2-mini-rtx-3050-6gb/)). That asked for 2.9 to 8.2 GB extra and forced `--no-op-offload`.

With UD-IQ2_XXS each layer's experts weigh ~0.26 GB instead of ~0.45. All 12 loop layers fit in 5.1 GB, and only the 12 outer layers (0-5 and 18-23), evaluated once, stay on the CPU. Copying those during prefill fits in the leftover VRAM.

## How many loop layers fit

`llama-server`, Unsloth's `b12675-mix` build, `-c 16384`, q8_0 KV, `--no-op-offload -ub 64`, real 2385-token prompt:

| Experts on GPU | VRAM | Prefill (tok/s) | Generation (tok/s) |
|---|---|---|---|
| loop 6-13 | 3.9 GB | 57 | 21.5 |
| loop 6-14 | 4.2 GB | 60 | 23.8 |
| loop 6-15 | 4.4 GB | 70 | 24.8 |
| loop 6-16 | 4.7 GB | 79 | 25.6 |
| **full loop (6-17)** | **5.1 GB** | **91** | **27.4** |
| 6-18 (one more outer layer) | 5.45 GB | 91 | 27.5 |
| 6-19 | — | doesn't start | — |

The extra outer layer adds nothing: what matters is the loop, evaluated three times.

## Prefill: op offload fits again

Full loop on GPU, same prompt:

| Config | VRAM | Prefill (tok/s) | Generation (tok/s) |
|---|---|---|---|
| `--no-op-offload -ub 512` | 5.3 GB | 138 | 27.2 |
| `--no-op-offload -ub 1024` | 5.6 GB | 141 | 26.7 |
| op offload, `-ub 512` | 5.45 GB | 349 | 27.7 |
| **op offload, `-ub 1024 -b 1024`** | **5.7 GB** | **436** | **27.2** |
| op offload, `-ub 1536` or `2048` (also with q4_0 KV) | — | doesn't start | — |

With a 5420-token prompt and the same config: **448 tok/s** prefill and 27.0 generation. f16 KV instead of q8_0 changes nothing.

Final config:

```
llama-server -m Inkling-2-Mini-UD-IQ2_XXS.gguf --jinja -c 16384 -np 1 \
  -ngl 99 -fit off -fa on -ctk q8_0 -ctv q8_0 -t 6 -tb 12 -lm none \
  -ub 1024 -b 1024 \
  -ot "blk\.([0-5]|18|19|20|21|22|23)\.ffn_.*_exps.*=CPU"
```

This GPU also drives the desktop, so 5.7 GB is about the limit. On a dedicated 6 GB card `-ub 1536` probably fits.

## Quality: small check against Qwen3.6-35B-A3B

Eight questions in Spanish with verifiable answers: arithmetic, logic, strict formatting, JSON extraction, a Colombian geography fact and a Python function run against five test cases. Temperature 0, reasoning on, 4096 output tokens max.

| Question | Inkling 2 Mini UD-IQ2_XXS | Qwen3.6-35B-A3B Q4_K |
|---|---|---|
| Minutes between 14:35 and 19:10 | ✅ | ❌ used all 4096 tokens thinking |
| Order four people by age | ✅ | ✅ |
| Nine shirts drying in the sun | ✅ | ✅ |
| 15% discount + 19% VAT | ✅ | ❌ used all 4096 tokens thinking |
| Capital of Córdoba and its river | ❌ said Magdalena (it's the Sinú) | ✅ |
| 3 bullets under 8 words | ✅ | ✅ |
| Extract data to JSON | ✅ | ✅ |
| `fusionar(intervalos)` function | ✅ | ✅ |
| **Total** | **7/8, 1 min 45 s** | **6/8, 10 min 24 s** |

With 8192 tokens of headroom, Qwen gets the two missing ones right (275 and 3,236,800), but uses 4754 and 4385 tokens and takes 162 and 108 s each. With enough budget it scores **8/8**: the issue isn't reasoning but how long it thinks before answering.

- **Inkling solves each question in 136-741 tokens.** Qwen uses 217 to 4754.
- **Inkling's miss is what you'd expect at 2 bits**: it loses memorized facts, not reasoning or instruction following.
- These are eight easy questions. They show IQ2_XXS doesn't break, not that it beats Qwen in general.

## Strata, for comparison

[Strata](https://github.com/Niko1221/Strata) ships its own Inkling engine: it keeps the most-used experts on the GPU and computes the rest on the CPU. With UD-Q3_K_XL on this GPU it gave **94 tok/s prefill but 9.5 generation**, and its own probe turned DSpark off (1.02x). With the same model, Unsloth's llama.cpp build generated twice as fast (19.5).

## Versus Qwen3.6-35B-A3B on the same GPU

| | Inkling 2 Mini UD-IQ2_XXS | Qwen3.6-35B-A3B (Q4_K + MTP) |
|---|---|---|
| Prefill | ~440 tok/s | 400-557 tok/s |
| Generation | 27 tok/s | 32-34 tok/s |
| VRAM | 5.7 GB | ~3.9 GB |
| Tokens per answer (small check) | 136-741 | 217-4754 |

## Conclusions

- On a **6 GB RTX 3050 Laptop**, Inkling 2 Mini at UD-IQ2_XXS does **27 tok/s generation and ~440 prefill**. It's the first Inkling setup on this GPU that works for long prompts.
- The key isn't the quant itself but what it enables: **the whole loop on the GPU and op offload back**.
- **Qwen3.6-35B-A3B is still faster per token**, but 2-bit Inkling answers sooner because it reasons more briefly. For chat and direct questions on this laptop, it's a real alternative.
