---
title: "Inkling 2 Mini en 2 bits en una RTX 3050 de portátil: 27 tok/s y 440 de prefill"
description: "Con UD-IQ2_XXS el bucle entero de Inkling 2 Mini cabe en 6 GB de VRAM y el op offload vuelve a ser posible: 27 tok/s generando y ~440 tok/s de prefill en una RTX 3050 Laptop, contexto máximo, versión sin censura y una mini-evaluación de calidad contra Qwen3.6-35B-A3B."
pubDate: 2026-11-25T15:30:00-05:00
tags: [llm, llama.cpp, linux, benchmark]
category: ia
draft: false
lang: es
translationKey: inkling-2-mini-iq2-rtx-3050-6gb
metric:
  value: "440 tok/s"
  label: "de prefill con Inkling 2 Mini en 6 GB de VRAM de portátil"
specs:
  - { label: "Laptop", value: "Lenovo IdeaPad Gaming 3" }
  - { label: "CPU", value: "Ryzen 5 7535HS (6c/12t)" }
  - { label: "GPU", value: "RTX 3050 Laptop, 6 GB VRAM, PCIe 4.0 x8" }
  - { label: "RAM", value: "32 GB DDR5-4800" }
  - { label: "Modelo", value: "Inkling 2 Mini, Unsloth UD-IQ2_XXS (8,5 GB)" }
  - { label: "llama.cpp", value: "Unsloth b12675-mix, CUDA" }
---

Segunda parte de [Inkling 2 Mini en una RTX 3050 de portátil](/posts/inkling-2-mini-rtx-3050-6gb/). Con UD-Q3_K_XL el techo era 48 tok/s de prefill y 19,5 de generación. Cambiando a la cuantización de 2 bits de Unsloth, en la misma **RTX 3050 Laptop de 6 GB**, el prefill se multiplica por 9.

## Resumen

- **UD-IQ2_XXS (8,5 GB) deja meter en la GPU los expertos de todo el bucle** (capas 6-17, las que se evalúan tres veces por token).
- **Generación: 27 tok/s**, frente a 19,5 con UD-Q3_K_XL.
- **Prefill: ~440 tok/s**, frente a 48. Con el bucle en GPU, el **op offload vuelve a caber** en 6 GB.
- **Calidad**, en una mini-evaluación de 8 preguntas verificables: 7/8 (Qwen3.6, 8/8 con tokens de sobra). El fallo de Inkling fue un dato inventado, no un error de razonamiento.
- **Contexto usable: 32k con el bucle entero en GPU**; hasta 128k pasando tres capas del bucle a CPU.
- **Sin censura**: la versión AD-IQ2_M de AtomicChat da 370 tok/s de prefill y ~24 generando con la misma configuración.
- **Contra Qwen3.6-35B-A3B** en la misma GPU: Qwen sigue generando más rápido (32-34 tok/s), pero Inkling responde antes porque piensa mucho menos.

![Inkling 2 Mini: todo lo que probé en una RTX 3050 Laptop de 6 GB](/images/inkling-2-mini-3050-es.png)

## Por qué la cuantización cambia tanto

Con UD-Q3_K_XL cabían en la GPU los expertos de 7 de las 12 capas del bucle. El resto de expertos vivía en CPU, y el op offload tenía que copiar a la GPU el tensor completo de 128 expertos de cada capa del bucle (ver [la primera parte](/posts/inkling-2-mini-rtx-3050-6gb/)). Eso pedía de 2,9 a 8,2 GB extra y obligaba a `--no-op-offload`.

Con UD-IQ2_XXS los expertos de cada capa pesan ~0,26 GB en vez de ~0,45. Caben las 12 capas del bucle en 5,1 GB, y en CPU solo quedan las 12 capas exteriores (0-5 y 18-23), que se evalúan una vez. Copiar esas capas durante el prefill ya entra en la VRAM que sobra.

## Cuántas capas del bucle caben

`llama-server`, build de Unsloth `b12675-mix`, `-c 16384`, KV q8_0, `--no-op-offload -ub 64`, prompt real de 2385 tokens:

| Expertos en GPU | VRAM | Prefill (tok/s) | Generación (tok/s) |
|---|---|---|---|
| bucle 6-13 | 3,9 GB | 57 | 21,5 |
| bucle 6-14 | 4,2 GB | 60 | 23,8 |
| bucle 6-15 | 4,4 GB | 70 | 24,8 |
| bucle 6-16 | 4,7 GB | 79 | 25,6 |
| **bucle completo (6-17)** | **5,1 GB** | **91** | **27,4** |
| 6-18 (una capa exterior más) | 5,45 GB | 91 | 27,5 |
| 6-19 | — | no arranca | — |

La capa exterior extra no aporta: lo que pesa es el bucle, que se evalúa tres veces.

## Prefill: el op offload vuelve a caber

Bucle completo en GPU, mismo prompt:

| Configuración | VRAM | Prefill (tok/s) | Generación (tok/s) |
|---|---|---|---|
| `--no-op-offload -ub 512` | 5,3 GB | 138 | 27,2 |
| `--no-op-offload -ub 1024` | 5,6 GB | 141 | 26,7 |
| op offload, `-ub 512` | 5,45 GB | 349 | 27,7 |
| **op offload, `-ub 1024 -b 1024`** | **5,7 GB** | **436** | **27,2** |
| op offload, `-ub 1536` o `2048` (también con KV q4_0) | — | no arranca | — |

Con un prompt de 5420 tokens y la misma configuración: **448 tok/s** de prefill y 27,0 de generación. KV en f16 en vez de q8_0 no cambia nada.

Configuración final:

```
llama-server -m Inkling-2-Mini-UD-IQ2_XXS.gguf --jinja -c 16384 -np 1 \
  -ngl 99 -fit off -fa on -ctk q8_0 -ctv q8_0 -t 6 -tb 12 -lm none \
  -ub 1024 -b 1024 \
  -ot "blk\.([0-5]|18|19|20|21|22|23)\.ffn_.*_exps.*=CPU"
```

Esta GPU también dibuja el escritorio, así que 5,7 GB es prácticamente el máximo. En una tarjeta dedicada de 6 GB probablemente entra `-ub 1536`.

## Contexto máximo

Medido llenando el 88 % del contexto con texto real (docs de llama.cpp) y generando 150 tokens al final:

| Contexto | KV | Expertos en GPU | VRAM pico | Prefill (tok/s) | Generación al final (tok/s) |
|---|---|---|---|---|---|
| 16k | q8_0, `-ub 1024` | bucle completo | 5,8 GB | 467 | 24,8 |
| **32k** | **q4_0, `-ub 512`** | **bucle completo** | **5,5 GB** | **358** | **20,7** |
| 64k | q4_0, `-ub 512` | bucle 6-16 | 5,5 GB | 302 | 16,6 |
| 128k | q4_0, `-ub 512` | bucle 6-14 | 5,5 GB | 265 | 12,8 |
| 256k | — | — | — | no arranca | — |

- **Que arranque no basta.** Con 5,7 GB ocupados al cargar, 32k con KV q8 arranca, pero al llenar el contexto CUDA se queda sin memoria (`cudaGraphInstantiate`). Hay que dejar unos 300 MB libres al cargar.
- **RAM**: el proceso ocupa ~4,9 GB. Con `-lm none` los expertos de las capas exteriores se cargan enteros en RAM y el disco no se vuelve a leer.

## Calidad: mini-evaluación contra Qwen3.6-35B-A3B

Ocho preguntas en español con respuesta verificable: aritmética, lógica, formato estricto, extracción a JSON, un dato de geografía colombiana y una función de Python que se ejecuta contra cinco casos de prueba. Temperatura 0, razonamiento activado, 4096 tokens de salida máximo.

| Pregunta | Inkling 2 Mini UD-IQ2_XXS | Qwen3.6-35B-A3B Q4_K |
|---|---|---|
| Minutos entre 14:35 y 19:10 | ✅ | ❌ agotó los 4096 tokens pensando |
| Ordenar cuatro personas por edad | ✅ | ✅ |
| Nueve camisas secándose al sol | ✅ | ✅ |
| Descuento del 15 % + IVA del 19 % | ✅ | ❌ agotó los 4096 tokens pensando |
| Capital de Córdoba y su río | ❌ dijo río Magdalena (es el Sinú) | ✅ |
| 3 viñetas de menos de 8 palabras | ✅ | ✅ |
| Extraer datos a JSON | ✅ | ✅ |
| Función `fusionar(intervalos)` | ✅ | ✅ |
| **Total** | **7/8, 1 min 45 s** | **6/8, 10 min 24 s** |

Con 8192 tokens de margen, Qwen acierta las dos que le faltaban (275 y 3.236.800), pero usa 4754 y 4385 tokens y tarda 162 y 108 s en cada una. Con margen suficiente queda **8/8**: el problema no es de razonamiento sino de cuánto piensa antes de contestar.

- **Inkling resuelve cada pregunta con 136-741 tokens.** Qwen gasta entre 217 y 4754.
- **El fallo de Inkling es el esperable en 2 bits**: pierde datos memorizados, no la capacidad de razonar ni de seguir formato.
- Son ocho preguntas fáciles. Dicen que IQ2_XXS no se rompe, no que sea mejor que Qwen en general.

## Strata, para comparar

[Strata](https://github.com/Niko1221/Strata) trae su propio motor para Inkling: deja en GPU los expertos más usados y calcula el resto en CPU. Con UD-Q3_K_XL en esta GPU dio **94 tok/s de prefill pero 9,5 de generación**, y su propia medición descartó DSpark (1,02x). Con el mismo modelo, la build de Unsloth de llama.cpp generaba el doble de rápido (19,5).

## Versión sin censura

AtomicChat publica [Inkling-2-Mini-Uncensored-GGUF](https://huggingface.co/AtomicChat/Inkling-2-Mini-Uncensored-GGUF) de dos formas: una LoRA de 44 MB que se aplica sobre cualquier GGUF y archivos con el cambio ya horneado. Las dos quitan la negativa (el modelo base se niega a explicar cómo abrir una cerradura con ganzúas; con el cambio lo explica).

| Mismo setup, 32k, KV q4_0 | VRAM | Prefill (tok/s) | Generación (tok/s) | Mini-eval |
|---|---|---|---|---|
| UD-IQ2_XXS (con censura) | 5,42 GB | ~349 | ~27 | 7/8 |
| UD-IQ2_XXS + LoRA (`--lora`) | 5,46 GB | 343 | 20,7 | 7/8 |
| **AD-IQ2_M sin censura (8,7 GB)** | **5,43 GB** | **370** | **23,8** | **7/8** |

La LoRA cuesta un 25 % de generación porque suma cálculo en cada capa, también en las que van en CPU. La versión horneada pesa casi lo mismo que UD-IQ2_XXS y no tiene ese coste. Con el contexto de 32k lleno, AD-IQ2_M da 367/21,1.

## Contra Qwen3.6-35B-A3B, en la misma GPU

| | Inkling 2 Mini UD-IQ2_XXS | Qwen3.6-35B-A3B (Q4_K + MTP) |
|---|---|---|
| Prefill | ~440 tok/s | 400-557 tok/s |
| Generación | 27 tok/s | 32-34 tok/s |
| VRAM | 5,7 GB | ~3,9 GB |
| Tokens por respuesta (mini-eval) | 136-741 | 217-4754 |

## Conclusiones

- En una **RTX 3050 Laptop de 6 GB**, Inkling 2 Mini en UD-IQ2_XXS da **27 tok/s generando y ~440 de prefill**. Es la primera configuración de Inkling en esta GPU que sirve para prompts largos.
- La clave no es la cuantización por sí sola, sino lo que permite: **todo el bucle en GPU y el op offload de vuelta**.
- **Qwen3.6-35B-A3B sigue siendo más rápido por token**, pero Inkling en 2 bits contesta antes porque razona más corto. Para chat y preguntas directas, en este portátil, es una alternativa real.
