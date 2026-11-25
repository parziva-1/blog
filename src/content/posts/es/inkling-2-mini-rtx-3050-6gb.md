---
title: "Inkling 2 Mini en una RTX 3050 de portátil: 19 tok/s generando, 40 leyendo"
description: "Inkling 2 Mini (26,4B MoE con capas en bucle) en una RTX 3050 Laptop de 6 GB con llama.cpp: qué expertos dejar en GPU, por qué el op offload no cabe, el techo de prefill, la caché de expertos, DSpark y la comparación con Qwen3.6-35B-A3B."
pubDate: 2026-11-24T21:30:00-05:00
tags: [llm, llama.cpp, linux, benchmark]
category: ia
draft: false
lang: es
translationKey: inkling-2-mini-rtx-3050-6gb
metric:
  value: "19 tok/s"
  label: "Inkling 2 Mini generando en 6 GB de VRAM de portátil"
specs:
  - { label: "Laptop", value: "Lenovo IdeaPad Gaming 3" }
  - { label: "CPU", value: "Ryzen 5 7535HS (6c/12t)" }
  - { label: "GPU", value: "RTX 3050 Laptop, 6 GB VRAM, PCIe 4.0 x8" }
  - { label: "RAM", value: "32 GB DDR5-4800" }
  - { label: "Modelo", value: "Inkling 2 Mini, Unsloth UD-Q3_K_XL (12,7 GiB)" }
  - { label: "llama.cpp", value: "b12697, b12703 y Unsloth b12675-mix, CUDA" }
---

Inkling 2 Mini (Thinking Machines, 20-nov) salió con la promesa de "un modelo de clase 26B en 4 GB de VRAM". Lo probé en una **RTX 3050 Laptop de 6 GB**, la misma GPU de los posts de [Flint 40B](/posts/flint-40b-moe-6gb-vram/) y [LFM3-1.7B](/posts/lfm3-1-7b-200k-rtx-3050/), que además es la GPU primaria del escritorio.

## Resumen

- **Generación: 18-19 tok/s** dejando en GPU los expertos de 7-8 capas del bucle. Con todo en CPU, 12,7.
- **Prefill: ~40 tok/s, y no hay forma de subirlo en 6 GB.** El op offload pide entre 2,9 y 8,2 GB extra de VRAM con este modelo.
- **La caché de prompts sí funciona**: el segundo mensaje con el mismo prefijo reusa 2381 de 2385 tokens. En un chat, solo el primer mensaje paga el prefill.
- **DSpark (decodificación especulativa) no ayuda en 6 GB**: con la build de Unsloth carga, pero baja la generación a 11-13 tok/s.
- **Actualización:** con la build `b12675-mix` de Unsloth, **48 tok/s de prefill y 19,5 de generación** (+26 % y +11 % frente a llama.cpp oficial). Ver al final.
- **Segunda parte:** con UD-IQ2_XXS el bucle entero cabe en la GPU: [27 tok/s y ~440 de prefill](/posts/inkling-2-mini-iq2-rtx-3050-6gb/).
- **En esta GPU, Qwen3.6-35B-A3B le gana**: pp 400-557 y tg 32-34 con MTP.

## El modelo

MoE de 26,4B con 128 expertos y 8 activos (3,4B activos por pasada). Su rasgo distintivo: **las capas 6-17 se evalúan tres veces por token** con pesos compartidos, cada pasada con su propia caché. Eso cambia cómo conviene repartirlo entre GPU y CPU.

GGUF: [Unsloth UD-Q3_K_XL](https://huggingface.co/unsloth/Inkling-2-Mini-GGUF) (13,6 GB), el más chico de los que se recomiendan para 6-8 GB. El soporte está en llama.cpp desde [#32694](https://github.com/ggml-org/llama.cpp/pull/32694).

## Qué expertos van a la GPU

La idea viene de [@analogalok](https://x.com/analogalok), que sacó 22 tok/s en una RTX 4060 de 8 GB: en vez de `--n-cpu-moe`, que manda a CPU las primeras N capas, usar `-ot` para dejar en GPU los expertos de las capas del bucle, que se usan 3 veces por token, y mandar a CPU los de las capas exteriores. En 6 GB no cabe el bucle entero, así que barrí cuántas capas caben.

`llama-bench`, b12697, `-ngl 99 -fa on -ctk q8_0 -ctv q8_0 -t 6 -lm none -nopo 1`:

| Expertos en GPU | `-ub` | pp512 (tok/s) | tg128 (tok/s) |
|---|---|---|---|
| ninguno (`-ncmoe 24`) | 64 | 24,8 | 12,7 |
| bucle 6-11 | 64 | 41,2 | 18,0 |
| bucle 6-11 | 256 | 46,7 | 18,0 |
| bucle 6-12 | 64 | 43,0 | 18,6 |
| bucle 6-12 | 256 | 45,6 | 18,7 |
| **bucle 6-13** | **64** | **47,8** | **19,4** |
| bucle 6-14 | — | no carga (6,1 GB de pesos en GPU) | — |

Patrón para `-ot` (aquí, bucle 6-12 en GPU):

```
-ot "blk\.([0-5]|13|14|15|16|17|1[89]|2[0-3])\.ffn_.*_exps.*=CPU"
```

`llama-server` necesita algo más de VRAM que `llama-bench`: con 16k de contexto, **6-13 no arranca y 6-12 sí** (5,4 GB). Configuración final:

```
llama-server -m Inkling-2-Mini-UD-Q3_K_XL.gguf --jinja -c 16384 -np 1 \
  -ngl 99 -fit off -fa on -ctk q8_0 -ctv q8_0 -t 6 -tb 12 -lm none \
  --no-op-offload -ub 64 \
  -ot "blk\.([0-5]|13|14|15|16|17|1[89]|2[0-3])\.ffn_.*_exps.*=CPU"
```

Generando 700 tokens en español: **18,4 tok/s**. Para que el reparto manual se respete hace falta `-fit off`; el ajuste automático de `llama-server` aborta con `-ngl` fijo.

## Por qué el prefill no sube

Con op offload (el comportamiento por defecto), llama.cpp copia a la GPU los pesos de los expertos que viven en CPU para procesar el prompt en lotes. En los MoE normales copia solo los expertos seleccionados. **Con Inkling copia el tensor completo**, con los 128 expertos, porque cada pasada del bucle puede elegir expertos distintos de la misma copia. Está marcado como TODO en `src/llama-context.cpp` (`sched_copy_experts`, ver [#32807](https://github.com/ggml-org/llama.cpp/pull/32807)).

Resultado: el buffer de cómputo se dispara.

| Configuración (op offload activo) | Buffer CUDA pedido |
|---|---|
| bucle 6-12 en GPU, `-ub 64` | 2,9 GB |
| bucle 6-9 en GPU, `-ub 512` | 4,6 GB |
| bucle 6-8 en GPU, `-ub 1024` | 5,5 GB |
| ningún experto en GPU, `-ub 512` | 6,8 GB |
| ningún experto en GPU, `-ub 2048` | 7,7 GB |
| `-cmoe` + `--moe-cache-mib 2000`, `-ub 512` | 8,2 GB |

En 6 GB nada de eso entra, así que **`--no-op-offload` es obligatorio** y el prompt lo procesa la CPU: 6 núcleos Zen 3 dan ~40 tok/s. Con un prompt real de 2385 tokens en `llama-server` (b12703), **38 tok/s**.

La caché de expertos en GPU (`--moe-cache-mib`) solo arranca junto con `--no-op-offload`, y así es peor: con 2000 MiB, pp 27 y tg 10,0.

## Lo que sí ayuda: la caché de prompts

Mismo prompt de 2385 tokens enviado dos veces al mismo slot: la segunda vez `llama-server` reusa 2381 tokens y solo procesa 4. Las cachés propias del bucle y las convoluciones no rompen la reutilización del prefijo.

En la práctica, el primer mensaje de una conversación con un system prompt largo (un cliente con 30+ herramientas MCP manda unos 11k tokens) tarda ~4-5 minutos en empezar. Los siguientes empiezan casi al instante.

## DSpark

Unsloth publica un borrador DSpark (`dspark-Inkling-2-Mini-Q8_0.gguf`, 0,5 GB) para decodificación especulativa. Con b12703 no carga: `joint_proj.weight` mide 5120×768 y el código espera 2816×768. El soporte que corresponde ([#32218](https://github.com/ggml-org/llama.cpp/pull/32218)) está en `master`, pero en ningún tag publicado a la fecha. El archivo `_Old` tampoco sirve: su vocabulario es de 201 024 tokens y el modelo usa 200 058. Con la build de Unsloth sí carga: ver la actualización al final.

## Contra Qwen3.6-35B-A3B, en la misma GPU

| | Inkling 2 Mini (UD-Q3_K_XL) | Qwen3.6-35B-A3B (Q4_K + MTP) |
|---|---|---|
| Prefill | ~40 tok/s | 400-557 tok/s |
| Generación | 18-19 tok/s | 32-34 tok/s |
| VRAM | 5,4 GB | ~3,9 GB |

Qwen3.6 usa op offload sin problema y tiene MTP en llama.cpp. Su model card además avisa que la calidad baja fuera del inglés; en español respondió bien a una explicación técnica de 700 tokens, pero no hice una evaluación de calidad.

## Actualización: la build de Unsloth (b12675-mix)

Unsloth publica builds de llama.cpp que mezclan la versión oficial con unos 35 PRs propios. Las de Inkling incluyen flash attention "banded" para el sesgo relativo ([#386](https://github.com/unslothai/llama.cpp/pull/386)), atención por bloques ([#385](https://github.com/unslothai/llama.cpp/pull/385)), DSpark con los dos formatos de borrador ([#405](https://github.com/unslothai/llama.cpp/pull/405)) y kernels CUDA fusionados para Turing–Ada. Ojo: **la etiqueta del repositorio no contiene esas mezclas**. Compilarla desde el código da `unknown model architecture: 'inkling2_loop'`; hay que usar el binario de la release (`app-b12675-mix-d14fe45-linux-x64-cuda13-older`, que cubre sm 75/80/86/89).

Mismo servidor, mismo prompt de 2385 tokens, `-c 16384`, KV q8, `--no-op-offload -ub 64`:

| Build | Expertos en GPU | Prefill (tok/s) | Generación (tok/s) |
|---|---|---|---|
| llama.cpp b12703 | bucle 6-12 | 38 | 17,6 |
| **Unsloth b12675-mix** | **bucle 6-12** | **48** | **19,5** |
| Unsloth b12675-mix | bucle 6-13 o más | no arranca | — |
| Unsloth + DSpark (borrador en CPU) | bucle 6-12 | 42 | 11,2 |
| Unsloth + DSpark (borrador en GPU) | bucle 6-11 | 39 | 13,3 |
| Unsloth + DSpark (borrador en GPU) | bucle 6-10 | 36 | 12,3 |

- **+26 % de prefill y +11 % de generación** sin cambiar nada más.
- **Más capas del bucle en GPU siguen sin caber.** Como esta GPU también dibuja el escritorio, en la práctica quedan unos 5,4 GB útiles.
- **DSpark carga pero no conviene aquí**: acepta el 56 % de los tokens propuestos (2,7 por paso de media), y verificar cada borrador cuesta caro con el bucle triple y la mayoría de expertos en CPU. En tarjetas donde el bucle entero cabe en la GPU probablemente sí compensa.

## Conclusiones

- En una **RTX 3050 Laptop de 6 GB**, Inkling 2 Mini funciona a **19,5 tok/s** con la build de Unsloth, pero el prefill de ~40-48 tok/s lo deja para prompts cortos o chats donde la caché de prompts amortiza el primer mensaje.
- El límite no es la GPU sino cómo llama.cpp hace hoy el op offload de este modelo. Si se resuelve el TODO de copiar solo los expertos usados, o se reduce el buffer de máscaras de atención, el prefill podría saltar.
- **Para este portátil, Qwen3.6-35B-A3B sigue siendo la mejor opción local.** Inkling vale la pena repetirlo cuando llama.cpp copie solo los expertos usados en el op offload.
