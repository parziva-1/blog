---
title: "Cómo evito que Android mate mi servidor casero"
description: "Un Galaxy S21 FE con root como servidor 24/7: el freezer de Termux, SELinux en sshd, Wi-Fi que pierde paquetes grandes, supervisor, RAM, batería y térmicas medidas."
pubDate: 2026-11-11T08:01:00-05:00
tags: [android, homelab, termux, magisk]
category: android
draft: false
lang: es
translationKey: s21fe-keep-android-alive
specs:
  - { label: "Teléfono", value: "Samsung Galaxy S21 FE (SM-G990E)" }
  - { label: "Arranque", value: "Termux:Boot (supervisor y sshd) + service.d de Magisk (ADB por Wi-Fi)" }
  - { label: "Carga limitada", value: "70 %" }
  - { label: "Térmica", value: "reposo 43-56 °C, carga total 82-85 °C" }
---

Esta es la cuarta parte de la serie "Un celular como servidor". En la [primera](/posts/s21fe-docker-server/) dejé Docker corriendo en un Galaxy S21 FE con root. Aquí va lo que viene después y que casi nadie cuenta: Android está diseñado para ahorrar batería y matar procesos, y un servidor necesita exactamente lo contrario. Casi todo lo que sigue nació de un fallo real.

## El freezer de apps en caché

El primer síntoma fue raro: el puerto SSH aceptaba conexiones, pero la sesión se quedaba colgada en el saludo. No era RAM ni un sshd roto. Android había congelado la app Termux (su "cached apps freezer") porque el servicio de Termux perdió el primer plano, y el sshd que vive dentro quedó congelado con ella.

El diagnóstico es mirar en qué función del kernel está dormido el proceso:

```bash
cat /proc/$(pidof sshd)/wchan
# do_freezer_trap  -> congelado por Android
```

El arreglo inmediato, sin matar nada, es pedirle al servicio de Termux que mantenga un wakelock (un bloqueo que impide que el sistema lo duerma):

```bash
am startservice --user 0 \
  -n com.termux/com.termux.app.TermuxService \
  -a com.termux.service_wake_lock
```

Lo permanente es que lo haga mi supervisor en cada ciclo: si el servicio no está en primer plano, repone el wakelock y deja una línea en su log.

## sshd: lanzarlo bien o perder el DNS

Si sshd muere, hay que relanzarlo, y la forma importa. Mi método viejo era `su <uid-de-termux> -c sshd`. Funciona, pero el proceso queda con el contexto SELinux de Magisk (la etiqueta de seguridad con la que Android decide qué puede hacer un proceso) en vez del de una app normal, y el DNS de Android rechaza ese contexto. Resultado: puedes entrar por SSH, pero dentro de la sesión no hay DNS (`pkg update` dice que ningún espejo es accesible).

La forma correcta es pedírselo a Termux mismo, con su `RunCommandService`:

```bash
am startservice --user 0 \
  -n com.termux/com.termux.app.RunCommandService \
  -a com.termux.RUN_COMMAND \
  --es com.termux.RUN_COMMAND_PATH "$PREFIX/bin/sshd" \
  --ez com.termux.RUN_COMMAND_BACKGROUND true
```

Ese comando hay que lanzarlo como el usuario de Termux, no como root: como root falla por falta del permiso `RUN_COMMAND`. Y se verifica el contexto:

```bash
cat /proc/$(pidof sshd)/attr/current
# debe decir untrusted_app..., no magisk
```

Al encender, un script de Termux:Boot arranca sshd por la vía correcta. Si muere más tarde, lo relanzo igual, nunca con `su`.

## Wi-Fi que pierde paquetes grandes

Un día SSH se colgaba en el intercambio de claves, desde cualquier equipo. Lo que pasaba: el Wi-Fi del teléfono descartaba los paquetes de más de unos 1200 bytes. La prueba es un ping que prohíbe fragmentar:

```bash
ping -M do -s 1300 <ip-del-telefono>   # falla
ping -M do -s 1172 <ip-del-telefono>   # pasa
```

Con paquetes pequeños todo parecía sano (ping, conexión TCP), y por eso es un fallo difícil de ver. Reconectar el Wi-Fi lo arregla (`cmd wifi set-wifi-enabled disabled` y luego `enabled`), así que ahora hay un vigilante de red (watchdog) que cada ciclo hace esa misma prueba contra la puerta de enlace con 1400 bytes. Si falla tres veces seguidas y la red local sigue arriba, reconecta el Wi-Fi, como máximo una vez cada 30 minutos.

Dos reglas más del vigilante, aprendidas con otros cortes: solo reinicia el Wi-Fi si falla la puerta de enlace (nunca porque se cayó internet) y, tras apagar y encender, fuerza un escaneo con `cmd wifi start-scan`; sin eso, tras un apagón largo el teléfono se quedó 11 horas sin reasociarse.

## El supervisor

Todo lo anterior cuelga de un bucle en shell que arranco con Termux:Boot al encender el teléfono. (La carpeta `service.d` de Magisk la uso solo para dejar activo el ADB por Wi-Fi, que es mi canal de rescate.) Cada 30 segundos revisa:

- montajes de disco,
- que `dockerd` esté vivo,
- el demonio de VPN,
- los montajes FUSE (discos remotos que corren como un programa normal),
- la guardia de RAM,
- las reglas de firewall,
- el wakelock de Termux.

> [!NOTE]
> Editar el script del supervisor no cambia el proceso que ya está corriendo: el bucle está cargado en memoria. Hay que relanzarlo o esperar al próximo arranque.

Un fallo que me causé yo mismo: tras actualizar el kernel, `dockerd` no levantaba. `containerd` tenía que limpiar una montaña de procesos "shim" (pequeños intermediarios entre containerd y cada contenedor) huérfanos acumulados con los meses, y mi supervisor lo mataba cada ~90 segundos antes de que terminara. Un livelock autoinfligido (el sistema se queda reintentando sin avanzar). Arreglo: subir el tiempo de espera interno de 60 a 240 segundos.

## RAM, load y bloatware

En este montaje los límites de memoria de Docker (`--memory`) se ignoran en silencio, así que un contenedor desbocado se puede comer el teléfono. La defensa real es una guardia en el supervisor: si la memoria disponible baja de ~700 MB, libera cachés y reinicia el contenedor más grande.

Y no te fíes del load average: en Android sube a 14-17 por hilos del kernel y FUSE esperando E/S (entrada/salida), con la CPU casi ociosa. Mira `%idle` y el consumo por proceso.

Para liberar RAM desactivé unos 45 paquetes (Play Store incluida) con `pm disable-user --user 0 <paquete>`, reversible con `pm enable --user 0 <paquete>`. Algunos, como los servicios de Google, vuelven a activarse solos, así que toca revisarlos.

> [!WARNING]
> Nunca ejecutes `pkg upgrade` a ciegas en Termux: sobrescribe la configuración endurecida de sshd (solo llaves). Usa `apt-get -o Dpkg::Options::=--force-confold upgrade` y relanza sshd justo después.

## Batería y térmicas

Un teléfono enchufado 24/7 es una mala idea para su batería, así que limito la carga al 70 % con el parámetro del driver de batería (`batt_full_capacity`).

También tengo un registrador que cada 2 minutos anota nivel, voltaje, temperatura, fuente de carga (pared o USB) y estado térmico en un CSV, recortado a unos 14 días. No alerta; solo guarda datos.

El motivo es un incidente real: el teléfono se apagó estando "enchufado". La causa de arranque decía `shutdown,battery`, con la batería en ~58 %. La térmica estaba normal. Cargaba por el USB-C de un portátil, no por un cargador de pared. La primera vez la causa fue un cable flojo en ese puerto: lo cambié a un cargador de pared y se arregló. Desde entonces ha vuelto a pasar, sin una causa confirmada, y no quiero inventar una. El registrador existe para que el próximo apagado deje datos en vez de solo un mensaje de arranque.

Temperaturas que medí el 11 de noviembre de 2026:

| Situación | Resultado |
|---|---|
| Reposo | 43-56 °C |
| 8 núcleos al 100 % | 82-85 °C en 15 s |
| Núcleos grandes bajo carga | bajan de ~2 GHz a ~1 GHz hacia los 45 s |
| Tras soltar la carga | ~47 °C a los 20 s |

O sea: el teléfono aguanta ráfagas, pero la carga sostenida lo frena (throttling). Para un servidor casero, que casi siempre está ocioso, es aceptable.

## Lo que aprendí

Un servidor en Android no es "instalar y olvidar". Cada fallo de esta lista (el freezer, el sshd sin DNS, el Wi-Fi que pierde paquetes grandes, el livelock de `dockerd`) lo descubrí porque el servidor dejó de responder, y cada uno terminó como un chequeo permanente en el supervisor, que revisa todo cada 30 segundos. Si montas algo parecido, empieza por tres cosas: el wakelock de Termux, un ping con paquetes grandes contra tu puerta de enlace y un registro de batería y temperatura antes de necesitarlo. El apagado que se repitió sigue sin causa, y lo voy a atacar con los datos del registrador.
