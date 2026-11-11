---
title: "Un MoE de 40B a 120k de contexto en un portátil con 6 GB de VRAM"
description: "Cómo hice correr un modelo MoE de 40B (2.5B activos) con 120k de contexto en un portátil con una RTX 3050 de 6 GB, qué ajustes importaron y qué no funcionó."
pubDate: 2026-11-11T08:10:00-05:00
tags: [llm, llama.cpp, linux]
category: ia
draft: false
lang: es
translationKey: flint-40b-moe-6gb
metric:
  value: "22 tok/s"
  label: "generación a 32k en 6 GB"
specs:
  - { label: "Laptop", value: "Lenovo" }
  - { label: "CPU", value: "Ryzen 5 7535HS" }
  - { label: "GPU", value: "RTX 3050, 6 GB VRAM" }
  - { label: "RAM", value: "32 GB" }
  - { label: "Modelo", value: "MoE 40B (2.5B activos), Mix-12G (~2.27 bpw en expertos)" }
  - { label: "Contexto", value: "122880 tokens" }
---

Quería un modelo local para programar con contexto largo (que pueda leer un repositorio entero, no solo un archivo) en el portátil que uso todos los días. Aquí va lo que medí, lo que funcionó y lo que no.

## El problema

El equipo es un portátil Lenovo con Ryzen 5 7535HS, RTX 3050 de 6 GB y 32 GB de RAM, con CachyOS. Seis gigas de VRAM (la memoria de la tarjeta gráfica) no alcanzan para un modelo denso decente, y mucho menos para 100k tokens de contexto. La RAM sí alcanza, pero si el modelo es denso, la CPU no da abasto.

## Por qué un MoE

Un modelo Mixture of Experts (MoE) tiene muchos parámetros, pero por cada token solo usa unos pocos "expertos". Aquí uso un modelo de 40B en total con 2.5B activos. Eso permite repartir el trabajo: la atención y el KV cache (la memoria del contexto) van en la GPU, y los expertos, que son casi todo el peso del modelo, se quedan en la RAM. Como cada token solo toca unos pocos, la CPU aguanta.

El modelo es una variante "abliterated" (sin los rechazos del entrenamiento original). La cuantización (comprimir los pesos del modelo usando menos bits por número) que mejor me funcionó es una mezcla de unos 12 GB (`Mix-12G`, expertos a ~2.27 bits por peso, o bpw), frente a la IQ4_XS de ~21 GB que usaba antes.

## La clave

Cuatro opciones, en orden de importancia:

- `--n-cpu-moe N`: deja en CPU los expertos de las primeras N capas. Cuanto menor N, más expertos en GPU, hasta que se acaba la VRAM. Con 6 GB, N=44 es lo máximo que cabe; con N=40 ya se queda sin memoria (OOM).
- KV cache en `q4_0` (`-ctk q4_0 -ctv q4_0`): a 120k de contexto el KV es lo que más pesa. Pasar de q8 a q4_0 liberó VRAM para meter 4 capas más de expertos en la GPU (de n48 a n44).
- `-ub 2048`: lotes grandes aceleran la lectura del prompt, porque cada viaje de los expertos por el PCIe rinde más.
- Contexto de 122880 con `--cache-ram 2048 --no-context-shift`: contexto fijo, sin que el servidor descarte mensajes viejos por su cuenta.

El pico de VRAM queda en ~5.3 GB, con ~0.75 GB de base del escritorio.

### Chrome se estaba comiendo 3 GB

Antes de medir tuve que resolver algo no relacionado: el Gemini Nano local de Chrome ocupaba cerca de 3 GB de VRAM. En 6 GB eso es la mitad. Se desactiva con la política empresarial `GenAILocalFoundationalModelSettings=1` (un JSON en el directorio de políticas gestionadas de Chrome). Sin eso, nada de lo que sigue cabe.

## Resultados

Todo a `-c 122880 --cache-ram 2048 --no-context-shift -ub 2048`, en tokens por segundo (pp = lectura del prompt, tg = generación de la respuesta):

| Config | VRAM pico (MiB) | RAM (GB) | tg vacío | 32k pp / tg | 100k pp / tg | 118k pp / tg |
|---|---|---|---|---|---|---|
| IQ4_XS, n48, KV q8 | 5323 | 21.4 | 34.4 | 619 / 22.3 | 456 / 11.4 | 346 / 11.7 |
| **Mix-12G, n44, KV q4_0** | 5342 | 11.3 | 33.6 | **875 / 22.4** | **606 / 13.3** | **490 / 11.8** |

Hay dos cosas que vale la pena destacar. El Mix gana en pp porque pesa la mitad y el pp está limitado por el PCIe. Y la RAM baja de 21 a 11 GB, lo que me deja usar el portátil mientras el servidor corre. Leer 100k tokens tarda unos 3 minutos; los turnos siguientes, entre 5 y 20 segundos gracias al cache de prompt.

Las cifras salen de una sola máquina y de pocas corridas, así que tómalas como referencia, no como verdad absoluta. (La fila de IQ4_XS es de una medición anterior, con otra compilación (build) de llama.cpp; el Mix está medido con una compilación más reciente que mejoró pp un 18-25 % sin tocar tg.)

## Calidad

Al cuantizar los expertos a ~2.3 bits me preocupaba que la calidad bajara. En mis pruebas no la hubo:

- Una función en Go con 16 aserciones ocultas, 3 muestras: 3/3 (igual que la IQ4_XS).
- Contexto largo (~109k tokens), 5 preguntas de recuperación: 5/5.
- Un agente de programación arreglando 4 bugs en Go, 2 corridas: 2/2, más rápido que con la IQ4_XS.

Son pruebas pequeñas y no un benchmark serio, pero cubren mi uso real.

## Lo que no funcionó

> [!FAIL]
> - `--moe-cache-mib` (una caché de expertos en VRAM): en 6 GB le quita memoria al buffer de cómputo y empeora todo. Con 400 MiB, pp a 32k baja de 875 a 823 y tg de 22.4 a 20.5. Con 600 MiB, OOM.
> - KV en f16: OOM, con n48 y con n54.
> - KV q8 con el Mix a n44 y q4_0 con n40: OOM. El margen es de una o dos capas.
> - Bajar `--n-cpu-moe` más allá de lo que cabe casi no sube tg, porque no es el límite.

## Por qué

Creo que la generación (tg) está limitada por la CPU, no por el ancho de banda: los tipos IQ1/IQ2 cuestan más de descomprimir en Zen 3+ sin AVX-512, y por eso, con la misma configuración de KV (q8), el Mix genera algo más lento que la IQ4_XS. Es mi interpretación, no algo que haya comprobado con un perfilador. Con el prompt pasa lo contrario: el pp está limitado por el PCIe Gen4 x8, porque los expertos suben a la GPU en cada ubatch (cada lote físico de tokens que procesa llama.cpp), y un modelo que pesa la mitad se beneficia directamente. Con la configuración final (KV q4_0 y cuatro capas de expertos más en GPU) la generación empata con la IQ4_XS a 32k y es más rápida a 100k: compensa la descompresión más cara.

## El comando final

```bash
llama-server -m Flint-abliterated-Mix-12G.gguf \
  -c 122880 --n-cpu-moe 44 -ub 2048 \
  --cache-ram 2048 --no-context-shift \
  -ctk q4_0 -ctv q4_0 \
  -ngl 99 -fa on --jinja -t 6 -fit off \
  --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0 \
  --host 127.0.0.1 --port 8091
```

Lo lanzo como servicio de usuario de systemd con un tope de memoria (`MemoryMax=24G`), porque un benchmark sin tope ya me congeló el equipo una vez.

## Qué haría con más VRAM

Con 8 GB la mejora sería pequeña: la mayoría de los expertos seguiría en la CPU, que es el cuello de botella. Con 12 GB entraría más de la mitad del modelo y la generación debería subir bastante. El salto grande está en los **16 GB**: ahí este modelo de 12 GB cabe entero en la GPU junto con el contexto de 120k en q4, y la CPU deja de ser el límite. Por eso, si algún día armo un servidor aparte para esto, la tarjeta tiene que ser de 16 GB o más, no de 8.
