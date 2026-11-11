---
title: "Almacenamiento grande en un celular: rclone + teldrive en Docker"
description: "Cómo monto teldrive con rclone (FUSE) en un celular con root y lo paso a contenedores Docker: mount-master, bind mounts, caché VFS y la regla anti-ban."
pubDate: 2026-11-11T08:02:00-05:00
tags: [android, docker, homelab, rclone, teldrive]
category: homelab
draft: false
lang: es
translationKey: s21fe-rclone-teldrive-docker
specs:
  - { label: "Backend", value: "teldrive (código abierto) + PostgreSQL" }
  - { label: "Montaje", value: "rclone con backend teldrive, FUSE" }
  - { label: "Caché VFS", value: "modo full, 10 GB, 24 h" }
  - { label: "Rate limit", value: "rate-limit=true, rate=50, rate-burst=3" }
---

Esta es la tercera parte de la serie "Un celular como servidor". Después del [root, el kernel y Docker](/posts/s21fe-docker-server/) y de la [transcodificación por hardware](/posts/s21fe-jellyfin-hw-transcoding/), toca el almacenamiento: cómo uso teldrive como disco grande y barato, lo monto con rclone en el celular y lo reparto a los contenedores.

## Por qué teldrive

El almacenamiento del teléfono es pequeño y el de un servidor casero cuesta. [teldrive](https://github.com/tgdrive/teldrive) es un proyecto de código abierto que guarda archivos en Telegram y los expone como un disco con API. Lo que me interesa es práctico: capacidad enorme por casi nada.

La contrapartida, sin adornos: es un truco ingenioso, no un servicio con garantías. La velocidad depende de la red y del límite de peticiones, y hay una regla que no se puede romper (ver "La regla anti-ban"). No guardes ahí nada que no puedas volver a conseguir.

## La arquitectura

Son tres piezas:

1. El servidor teldrive y su PostgreSQL, en una máquina alcanzable desde el celular. La base de datos es la fuente de verdad: si una copia local queda desfasada, te muestra un mundo que ya no existe. Aquí no entro en dónde corre.
2. rclone en el celular, con una compilación (build) que incluya el backend `teldrive`. El rclone de Termux no lo trae; yo uso una compilación aparte con ese backend. Monta el remoto como carpeta mediante FUSE (un mecanismo para montar discos que corren como un programa normal, fuera del kernel).
3. Contenedores Docker que montan esa carpeta con un bind mount (compartir una carpeta del anfitrión dentro del contenedor). En mi caso, un servidor multimedia y una herramienta que organiza archivos.

```
teldrive + PostgreSQL  <--HTTP-->  rclone (FUSE)  --bind-->  contenedores
```

## El montaje en Android

Este es el tramo donde más tiempo perdí, y casi todo es Android, no rclone.

### FUSE y el espacio de nombres de montajes

El kernel necesita FUSE (el mío lo tiene, ver parte 1). Pero Android tiene espacios de nombres de montaje por proceso: lo que montas en una sesión de `su` normal no lo ve nadie más, ni `dockerd`. La solución es `su -M` (mount-master): el comando corre en el espacio de nombres global y el montaje es visible para el demonio de Docker.

```bash
su -M -c 'rclone mount ...'
```

Si montas con `su` a secas, el montaje "existe" para ti y los contenedores ven una carpeta vacía. Lo vi más de una vez antes de entenderlo.

### Un ejemplo de comando

Así está el mío al 11 de noviembre de 2026, sin rutas:

```bash
rclone mount teldrive: /ruta/al/punto-de-montaje \
  --vfs-cache-mode full \
  --vfs-cache-max-size 10G \
  --vfs-cache-max-age 24h \
  --buffer-size 64M \
  --dir-cache-time 6h \
  --poll-interval 1h \
  --attr-timeout 1m \
  --rc --rc-addr 127.0.0.1:<puerto>
```

Lo que importó:

- Lectura y escritura, con cuidado. Mi montaje de teldrive es de lectura y escritura porque una herramienta organiza archivos ahí. Eso tiene riesgos que explico en la sección de corrupción. Si tus contenedores solo leen, agrega `--read-only`: es la forma más barata de evitar accidentes. (Otro montaje que tengo, hacia un disco de red, sí es de solo lectura.)
- `--dir-cache-time 6h`: evita listar el remoto en cada `ls`. Un escaneo de biblioteca multimedia haría cientos de listados. El precio: si borras o cambias algo en el servidor, el celular tarda hasta 6 horas en enterarse.
- `--vfs-cache-mode full` con 10 GB y 24 horas: lo leído queda en disco local (esa es la caché VFS, la capa de archivos virtual de rclone). Con la caché ya llena leo a ~80-110 MB/s, limitado por la memoria flash del teléfono; sin caché, ~8 MB/s. Es la diferencia entre un video que arranca y uno que se atasca.
- `--rc` escuchando solo en `127.0.0.1`: activa el control remoto de rclone para consultar estadísticas del VFS y olvidar rutas de la caché sin remontar. Nunca lo expongas a la red: sin autenticación, cualquiera podría manejar tu montaje.

En mis mediciones rclone no es el cuello de botella: ~57 MB de RAM y CPU casi en cero.

### Propagación del bind mount

Aquí está la trampa que más sorprende. Un contenedor con bind mount a una carpeta FUSE se queda con el montaje tal como estaba al crearlo. Si rclone muere y se remonta, el contenedor sigue apuntando al montaje viejo: ve la carpeta vacía o un error de "Transport endpoint is not connected".

Mi supervisor (un bucle de 30 segundos) lo resuelve en dos pasos:

1. Si el montaje no está, lo vuelve a montar.
2. Para cada contenedor que usa el montaje, ejecuta un `ls` dentro. Si el listado sale vacío, el bind está roto, y recrea el contenedor.

Recrear es lo único que funciona de forma fiable. Con otras opciones, como un desmontaje diferido (`umount -l`), el rclone viejo sigue sirviendo el bind del contenedor. Tampoco se aplica una opción nueva: el supervisor solo monta si no hay montaje, así que para cambiar una opción de rclone hay que matar el proceso, esperar a que el supervisor remonte con el comando actualizado y dejar que recree los contenedores.

> [!NOTE]
> Los contenedores que leen el montaje deben poder recrearse sin pérdida: su configuración y sus datos viven en volúmenes aparte, no dentro del contenedor.

## La regla anti-ban

Telegram limita el ritmo de solicitudes. Si te pasas, recibes esperas obligatorias (flood wait: el aviso de que debes esperar antes de volver a pedir) y, en el peor caso, te pueden restringir la cuenta que sostiene todo el almacenamiento.

Teldrive trae un limitador propio. Mi configuración, y no la cambio por nada:

```toml
rate-limit = true
rate = 50
rate-burst = 3
```

> [!WARNING]
> Nunca pongas `rate-limit=false`. Ese limitador es un techo que te protege: con él puedes permitirte más concurrencia en las descargas, porque reduce mucho el riesgo de pasarte del límite (un limitador local no te garantiza nada frente a Telegram, pero ayuda bastante). Sin él, un escaneo de biblioteca descontrolado puede costarte la cuenta. Tras cualquier trabajo pesado, revisa que no haya esperas de flood en los registros del servidor, con una herramienta que oculte nombres.

## Corrupción: `parts.mismatch`

Teldrive divide los archivos en partes. A veces un archivo queda con partes que no coinciden con lo esperado y el servidor responde con un error `parts.mismatch`. El síntoma desde fuera: el servidor multimedia entra en un bucle de lectura, el video se atasca o no abre.

Lo que aprendí:

- No confíes en una lista previa de archivos corruptos. Una vez mi lista vieja daba por rotos muchos archivos que estaban sanos. Verifica de nuevo: pide al servidor el principio y el final del archivo con solicitudes de rango. Uno sano devuelve los bytes pedidos; uno corrupto devuelve un cuerpo de error diminuto. Hay que mirar principio y final, porque el daño puede estar en las partes de atrás.
- Un tiempo de espera agotado (timeout) no es corrupción. Con el servidor congestionado hay lecturas que fallan y salen bien al reintentar.
- No pruebes con agresividad archivos corruptos: leer uno puede hacer caer el servidor teldrive.
- El borrado lógico no borra de verdad. Mi borrado inicial solo marcó los archivos como pendientes de borrar, y el servidor seguía sirviéndolos si conocías su id. Hay que revisar cómo se purgan.
- Después de borrar, refresca la caché del celular (o espera a que expire el `dir-cache-time`); si no, el servidor multimedia sigue viendo archivos que ya no existen. Matar el proceso rclone y dejar que el supervisor remonte y recree los contenedores es lo que me funcionó.

### Sobrescribir encima de un VFS es peligroso

Aprendí esta regla por las malas. Un script mío copiaba un archivo que se actualizaba a menudo con `cp -f`, es decir, sobrescribiendo directamente sobre el archivo en el montaje de escritura. En el VFS de rclone, sobrescribir trunca y reescribe el mismo objeto, y puede dejar el id anterior atascado en la cola de escritura. El resultado: decenas de miles de errores "record not found" por día, hasta que limpié la cola a mano. Volvió a pasar unas horas después porque el script seguía igual.

La regla: nunca sobrescribir directamente sobre el archivo en un montaje VFS de rclone. Borra y luego copia (o escribe uno nuevo y renombra).

Y su prima: mover archivos a mano sin un refresco correcto del VFS puede borrar los datos. Si el destino resuelve al mismo id que el origen, el borrado de uno se lo lleva todo, y una limpieza periódica del servidor termina el trabajo. Para mover cosas uso siempre una herramienta que haga el refresco, no `mv` ni `rclone move` directo.

## Lo que haría distinto

- Montaje de solo lectura desde el principio. El mío es de lectura y escritura (para que una herramienta organice archivos) y de ahí salieron los problemas de arriba. Si puedes, escribe por la API de teldrive con una vía aparte y deja el montaje solo para leer.
- Probar el supervisor con el montaje roto a propósito el primer día, no cuando se rompe solo.
- No me atrevo a decirte que esto aguanta años. Llevo meses usándolo y funciona. No tengo más datos que esos.

Siguiente y última parte: cómo evitar que Android mate todo esto, en [Mantener Android despierto](/posts/s21fe-keep-android-alive/).
