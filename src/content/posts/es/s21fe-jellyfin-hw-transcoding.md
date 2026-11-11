---
title: "Transcodificación por hardware en Jellyfin dentro de Docker, en un celular"
description: "Cómo conseguí que Jellyfin en Docker use el encoder de hardware de un Galaxy S21 FE con un puente hacia MediaCodec, y por qué el decode sigue en software."
pubDate: 2026-11-11T08:03:00-05:00
tags: [android, docker, jellyfin, ffmpeg]
category: android
draft: false
lang: es
translationKey: s21fe-jellyfin-hw-transcoding
repo: https://github.com/parziva-1/jellyfin-hwaccel-bridge
metric:
  value: "5.8x"
  label: "más rápido transcodificando HEVC"
specs:
  - { label: "Teléfono", value: "Samsung Galaxy S21 FE (Exynos 2100)" }
  - { label: "Encode", value: "hardware (h264_mediacodec / hevc_mediacodec)" }
  - { label: "Decode", value: "siempre software" }
  - { label: "Jellyfin", value: "en Docker, sin tocar" }
---

Jellyfin corre en Docker dentro de mi celular, y el chip tiene un encoder de video por hardware que ningún contenedor puede usar. Lo resolví con un puente de tres piezas. Es la parte 2 de la serie "Un celular como servidor"; la [parte 1](/posts/s21fe-docker-server/) cuenta cómo llegué a tener Docker en el teléfono.

## El problema: el encoder está ahí, pero no lo alcanzas

Transcodificar es convertir un video a otro formato o calidad para que el cliente lo pueda reproducir. Hecho por software, gasta mucha CPU. Mi celular tiene un encoder por hardware dentro del Exynos 2100, y Android lo expone con `AMediaCodec`, que vive en `libmediandk.so`.

Esa librería está compilada contra bionic, la biblioteca C de Android. Un contenedor Debian o Alpine usa glibc o musl, que son otras bibliotecas C. Un binario enlazado con glibc/musl no puede cargar una `.so` de bionic (con `dlopen`, la llamada que carga una librería mientras el programa corre). Da igual quién compile ffmpeg o con qué opciones: `--enable-mediacodec` dentro de un contenedor normal no llega al hardware que está en el mismo kernel.

Mi situación antes de esto: transcodificación 100 % por software. Medí HEVC (H.265, un formato más eficiente pero más pesado de procesar) a solo 1.18x tiempo real. Aquí "x tiempo real" mide la velocidad: 1x es justo la velocidad de reproducción, así que 1.18x es casi sin margen antes de que el video se corte.

## La idea: Jellyfin no necesita salir de Docker

Pensé primero en mover Jellyfin a Termux. No hace falta. Jellyfin es un servidor .NET sin dependencia de Android; solo ejecuta `ffmpeg` como proceso externo con una línea de comandos y una ruta configurable. El choque de ABI (la forma en que un binario espera hablar con las librerías del sistema) es un problema del binario de ffmpeg, no de Jellyfin.

También descarté compilar mi propio ffmpeg dentro del contenedor: sin un sistema bionic completo no hay forma, y aun así el decode por MediaCodec en un proceso sin pantalla tampoco se arregla recompilando (más abajo).

## Cómo está conectado

Tres piezas, todas en el repositorio:

1. `bridge-client.pl` (dentro del contenedor). Es el "ffmpeg falso": apuntas el argumento `--ffmpeg` de Jellyfin a este script. Recibe los mismos argumentos, devuelve stdout y stderr en vivo y sale con el mismo código que saldría ffmpeg. Está en Perl porque la imagen de Jellyfin (basada en Debian) ya trae Perl y no hay que instalar nada.
2. `bridge-daemon.py` (en el anfitrión, Termux). Un demonio (un programa que corre en segundo plano) que escucha solo en la dirección de la red interna de Docker, nunca en la red local. Recibe la lista de argumentos, traduce las rutas del contenedor a las rutas reales del anfitrión (los mismos volúmenes compartidos, vistos desde afuera) y lanza el wrapper.
3. `wrapper-ffmpeg.sh` (en el anfitrión; un wrapper es un script que envuelve a otro programa). Cambia solo el encoder (`-c:v libx264` pasa a `h264_mediacodec`, y lo mismo con HEVC), quita opciones que no tienen sentido para un encoder de hardware (`-preset`, `-crf`) y entrega todo lo demás al ffmpeg real de Termux.

```text
Jellyfin → bridge-client.pl ──(solo argumentos y texto)──► bridge-daemon.py
                                                              │ traduce rutas
                                                              ▼
                                       wrapper-ffmpeg.sh → ffmpeg + MediaCodec
```

Por el puente solo viajan los argumentos y el texto de salida. El video nunca pasa por ahí: entrada y salida están en los volúmenes que ambos lados ya comparten. Por eso es rápido y simple.

## Por qué el decode se queda en software

Después de comprobar que el encode funciona, la tentación es pasar `-hwaccel mediacodec` también al decode. No lo hagas. El decode por MediaCodec espera un contexto de app Android real (una superficie de dibujo de una `Activity`). Un proceso sin pantalla no lo tiene, y el resultado no es un error limpio: se cuelga, ignora SIGTERM (la orden amable de cerrarse) y solo SIGKILL (la orden de matarlo a la fuerza) lo detiene. Por lo que pude averiguar, es una limitación de cómo funciona MediaCodec, no algo que se arregle con opciones de ffmpeg.

Así que la regla es dura: el wrapper solo reescribe el encoder y quita cualquier `-hwaccel mediacodec` que llegue. Decode siempre software, encode por hardware.

> [!WARNING]
> `--disable-decoder=h264_mediacodec` al compilar ffmpeg evita el error, pero no desbloquea nada. Es solo una red de seguridad.

## Respaldo en software (fallback)

El encoder de hardware también rechaza o se cuelga con algunos archivos. El wrapper lo maneja así:

- Vigila la carpeta de segmentos HLS (el video partido en trocitos que el cliente va pidiendo) durante toda la vida del proceso. Si pasan 20 segundos sin que avance la fecha de modificación de ningún archivo, mata el intento por hardware (SIGTERM, y SIGKILL si lo ignora).
- Reintenta en silencio con encode por software. Un archivo incompatible baja a velocidad de software, no a un video roto.
- Fuerza `format=nv12,setrange=tv` justo antes del encoder. Algunos códecs viejos decodifican a un formato de píxeles que el encoder dice soportar pero con el que se cuelga.

El ciclo completo (cuelgue de hardware, fallback, entrega correcta) lo vi pasar con tráfico real.

## Resultados

Medidos con contenido real de mi biblioteca (un archivo H.264 y uno HEVC), en veces tiempo real (1x = justo a velocidad de reproducción):

| Caso | Solo software | Decode SW + encode HW |
|---|---|---|
| H.264 | 2.82x | 7.48x |
| HEVC | 1.18x | 6.82x |

HEVC era el caso crítico: pasó de casi sin margen a tener holgura. En pruebas de estrés de encode puro (45 s a 1080p) medí entre 4.3x y 4.8x, con dos sesiones concurrentes sin problemas. Es menos que los 6.82x de la tabla porque se midió de otra forma: encode puro, en una prueba sostenida de 45 s con dos sesiones a la vez, en vez del transcode de un archivo real.

Después del cambio de Jellyfin 10.11 a 12.1 y una actualización de ffmpeg en Termux, repetí cuatro pruebas sintéticas (H.264, MPEG-2, WMV1 y WMV2) y las cuatro usaron `h264_mediacodec` de verdad, no un fallback. El demonio sobrevivió porque vive en el anfitrión, fuera del ciclo de vida del contenedor.

## Tres cosas que me costaron tiempo

> [!FAIL]
> La primera vez que lo puse en producción tuve que revertirlo a los ocho minutos. Fueron cinco intentos hasta que quedó estable, y cada uno destapó un bug distinto.

- El prefijo `file:`: Jellyfin pasa rutas como `file:/ruta`. Si no traduces también eso, la ruta no se encuentra. Esa era la causa de dos "bugs" distintos.
- Un bloqueo con stdout: para un transcode, Jellyfin no lee la salida estándar del proceso, solo stderr. El cliente escribía a stdout de forma bloqueante, el buffer de la tubería (unos 64 KB) se llenaba y todo se paralizaba. Se arregló con escritura no bloqueante: un lector lento o ausente nunca debe impedir que sigas vaciando la entrada.
- El `PATH` al arrancar: los scripts de arranque no heredan el `PATH` de tu terminal. Un `python3` sin ruta absoluta fallaba en cada arranque. Usa rutas absolutas.

## Límites

- El decode sigue en software; no le encontré arreglo.
- Algunos archivos incompatibles caen a software.
- Todo depende de un solo teléfono encendido.
- La concurrencia solo la probé con dos sesiones.
- 4K y HDR solo los probé parcialmente.
- No he medido consumo eléctrico ni temperatura durante un transcode.

## Cómo probarlo

El patrón sirve para cualquier "Jellyfin en Docker con un encoder fuera del alcance del contenedor". Cambiando los nombres de encoder del wrapper podría servir, por ejemplo, para un dispositivo VAAPI (la interfaz de aceleración de video de Linux) que el contenedor no ve (no lo he probado).

1. En el anfitrión instala un ffmpeg con MediaCodec y copia `wrapper-ffmpeg.sh` y `bridge-daemon.py`.
2. Configura las variables `BRIDGE_BIND_ADDR`, `BRIDGE_PORT`, `BRIDGE_MEDIA_HOST_PATH`, `BRIDGE_CONFIG_HOST_PATH`, `BRIDGE_CACHE_HOST_PATH`, `BRIDGE_WRAPPER_PATH` y `REAL_FFMPEG`, y lanza el demonio con `run-daemon-resilient.sh`.
3. Mete `bridge-client.pl` en la imagen de Jellyfin (o móntalo) y apunta `--ffmpeg` a ese script.
4. Reinicia el contenedor.

Código y explicación completa: [jellyfin-hwaccel-bridge](https://github.com/parziva-1/jellyfin-hwaccel-bridge). Sigue la parte 3, sobre montar un almacenamiento remoto en Docker: [`s21fe-rclone-teldrive-docker`](/posts/s21fe-rclone-teldrive-docker/).
