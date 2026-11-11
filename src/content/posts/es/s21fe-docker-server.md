---
title: "Un Galaxy S21 FE como servidor 24/7 con Docker nativo"
description: "Root, GSI de Android 13 y un kernel propio para correr Docker directo en el celular, sin máquina virtual. Qué funciona y qué no, probado en el equipo."
pubDate: 2026-11-11T08:04:00-05:00
tags: [android, docker, homelab, kernel]
category: android
draft: false
lang: es
translationKey: s21fe-docker-server
repo: https://github.com/parziva-1/Proton
metric:
  value: "8 núcleos"
  label: "y 8 GB de RAM sirviendo contenedores 24/7"
specs:
  - { label: "Teléfono", value: "Samsung Galaxy S21 FE (SM-G990E, Exynos 2100)" }
  - { label: "Android", value: "13, GSI phh-treble arm64" }
  - { label: "Kernel", value: "5.4.302 ProtonPlus v6.1.1 (fork propio)" }
  - { label: "Root", value: "Magisk 27" }
  - { label: "Docker", value: "24.0.6 nativo, overlay2, sin máquina virtual" }
  - { label: "Datos", value: "ext4 dedicado" }
---

Esta es la primera parte de la serie "Un celular como servidor": cómo convertí un Galaxy S21 FE que tenía guardado en un servidor de contenedores que corre las 24 horas, con Docker directo sobre el kernel del teléfono. Nada de máquinas virtuales ni chroot: los contenedores usan el mismo kernel que Android.

Las otras partes:

- [Parte 2: Jellyfin con codificación de video por hardware](/posts/s21fe-jellyfin-hw-transcoding/)
- [Parte 3: rclone + teldrive como almacenamiento para Docker](/posts/s21fe-rclone-teldrive-docker/)
- [Parte 4: cómo evitar que Android mate el servidor](/posts/s21fe-keep-android-alive/)

Todo lo que digo aquí lo comprobé en el teléfono mientras escribía, no de memoria.

## Por qué un celular

- Ya lo tenía. Un gama alta de hace unos años tiene 8 núcleos ARM y 8 GB de RAM. Para un servidor casero eso sobra.
- Gasta poco. La mayor parte del tiempo la CPU está ociosa (el 11 de noviembre de 2026 medí 95 % de inactividad con cinco contenedores corriendo).
- La batería hace de UPS (una batería de respaldo, como la que protege a un computador de escritorio). Si se va la luz, el servidor sigue un buen rato.

Y la contra, para que nadie se lleve una sorpresa: un celular no es un servidor. Android está hecho para ahorrar batería y matar procesos, y buena parte del trabajo es convencerlo de que no lo haga. De eso trata la parte 4.

## Antes de empezar: lo que se pierde

> [!WARNING]
> - Se pierde Knox para siempre. Al desbloquear el bootloader (el programa que arranca el sistema), Samsung quema un fusible físico, el "warranty bit". No se puede volver atrás: adiós garantía, Samsung Pay, Carpeta Segura y cualquier cosa que dependa de Knox. En mi equipo el kernel lo reporta así: `androidboot.warranty_bit=1`.
> - El teléfono avisa en cada arranque. Con el bootloader desbloqueado sale una pantalla de advertencia al encender. Android llama a esto estado de arranque "orange" (naranja): significa que el sistema arranca aunque no esté firmado por Samsung. Es normal y no se quita.
> - Desbloquear el bootloader borra todo el teléfono. Haz una copia de seguridad antes.
> - Puedes dejarlo inservible si flasheas una partición equivocada o un kernel que no arranca. Guarda copias de `boot`, `vendor_boot` y `dtbo` antes de tocar nada.
> - La seguridad baja. Con root, SELinux (el módulo de Android que limita lo que puede hacer cada proceso) en modo permisivo y un kernel modificado, este equipo no debe guardar nada sensible ni usarse como teléfono principal. Yo no tengo cuentas bancarias ni nada personal en él.
> - Todo esto es para el SM-G990E (Exynos). No sirve para las versiones con Snapdragon.

## Qué hace falta

- Un Galaxy S21 FE con Exynos 2100.
- Un PC con `adb` y `fastboot` (o Odin/Heimdall para el modo descarga de Samsung) y un buen cable USB.
- El recovery OrangeFox para el S21 FE.
- Una GSI (una imagen genérica de Android que funciona en muchos teléfonos) de phh-treble con Android 13 para arm64.
- Magisk (uso la versión 27).
- Un kernel con lo que Docker necesita. El mío está en [parziva-1/Proton](https://github.com/parziva-1/Proton).
- Termux y el paquete `docker` de su repositorio root (instala `dockerd`, `containerd`, `runc` y el cliente).
- Un espacio ext4 aparte para los datos de Docker. La partición de datos de Android usa su propio esquema y cifrado, y no conviene mezclar.

## Los pasos, a grandes rasgos

No es un tutorial paso a paso: para cada punto hay guías mejores en el foro del S21 FE en XDA, y las enlazo al final. Lo que sí dejo es cómo compruebo que cada etapa quedó bien.

### 1. Bootloader y recovery

Se activa el desbloqueo OEM en las opciones de desarrollador, se desbloquea desde el modo descarga y se flashea OrangeFox. En Samsung además hay que flashear un `vbmeta` (el archivo que le dice al teléfono cómo verificar que el sistema no fue modificado) con la verificación desactivada; sin eso, el teléfono no arranca ni la GSI ni un kernel propio. El recovery es la herramienta que más se usa después: para copias de seguridad, para flashear la GSI y para cambiar de kernel.

Para comprobarlo: arrancar en OrangeFox y ver que monta y descifra los datos.

### 2. GSI de Android 13

Como dije arriba, una GSI es una imagen de Android genérica. Uso la de phh-treble, Android 13, arm64. Se flashea desde OrangeFox y se borran los datos.

```bash
adb shell getprop ro.build.version.release   # 13
```

### 3. Root con Magisk

Se parchea la imagen de arranque con la app de Magisk y se flashea. Dejo la app oculta (Magisk permite cambiarle el nombre al paquete).

```bash
adb shell su -c id   # uid=0(root)
```

Un detalle que confunde: con Magisk, `getprop` puede decir que el bootloader está bloqueado y verificado aunque no sea cierto, porque Magisk reescribe esas propiedades. La verdad está en la línea de comandos del kernel:

```bash
su -c "tr ' ' '\n' < /proc/cmdline | grep -E 'warranty_bit|verifiedbootstate'"
# androidboot.warranty_bit=1
# androidboot.verifiedbootstate=orange
```

### 4. Un kernel que sirva para Docker

Aquí está el trabajo de verdad. Parto de Proton+ para el Exynos 2100 (de ProtonKernel y EliteGalaxy) y mantengo un fork con lo que pide Docker, usando como lista el script `check-config.sh` del proyecto Moby y la guía de FreddieOliveira.

Lo que activé sobre la configuración original:

| Para qué | Opciones |
|---|---|
| Aislar procesos | `PID_NS`, `USER_NS`, `IPC_NS`, `SYSVIPC`, `POSIX_MQUEUE` |
| Grupos de control (cgroups) | `CGROUP_PIDS`, `CGROUP_DEVICE`, `CFS_BANDWIDTH`, `BLK_DEV_THROTTLING`, `CPUSETS` |
| Redes de Docker (bridge = red virtual propia de los contenedores) | `BRIDGE_NETFILTER`, `NETFILTER_XT_MATCH_ADDRTYPE`, `NETFILTER_XT_MATCH_IPVS`, `MACVLAN`, `IPVLAN` |
| NAT para IPv6 | `IP6_NF_NAT`, `IP6_NF_TARGET_MASQUERADE` |

El kernel se compila en GitHub Actions con tres variantes (`full`, `safe` y `base`), para tener una que arranque si otra falla, y se empaqueta en formato AnyKernel3 para flashearlo desde OrangeFox. Intenté también traer eBPF más moderno, pero rompía la compilación y lo dejé.

> [!NOTE]
> No te fíes de `/proc/config.gz` en este kernel. El mío reporta `PID_NS` y `CGROUP_PIDS` como desactivados, pero el kernel sí los tiene: un contenedor ve su propio PID 1, existen `/proc/self/ns/pid` y `/proc/self/ns/user`, y `/proc/cgroups` lista `pids`. La configuración embebida quedó desfasada respecto a la que realmente se compiló. Para saber qué hay, pruébalo directamente en el equipo:

```bash
uname -r                                   # 5.4.302-ProtonPlus-v6.1.1
ls /proc/self/ns                           # cgroup ipc mnt net pid ... user uts
awk 'NR>1{print $1, $4}' /proc/cgroups     # cada controlador y si está activo
ip link add t0 type dummy && ip link add t1 link t0 type macvlan && echo macvlan-ok
ip link del t1; ip link del t0
```

### 5. Docker

Instalo el paquete `docker` del repositorio root de Termux (cliente 24.0.6, containerd 1.6, runc 1.5) y lanzo `dockerd` como root. Los datos van al espacio ext4 propio, con el driver `overlay2`.

```bash
docker info --format '{{.Driver}} cgroup v{{.CgroupVersion}}'   # overlay2 cgroup v2
docker run --rm alpine sh -c 'echo $$'                             # 1
```

El arranque automático lo hace un script supervisor que lanzo con Termux:Boot al encender. Ese supervisor es el que mantiene vivo todo lo demás, y lo cuento en la parte 4.

## Qué funciona y qué no

Las pruebas de límites y de redes las hice el 11 de noviembre de 2026 con contenedores desechables, no las saqué de notas viejas. Lo de "meses seguidos" es distinto: es el tiempo de uso real que llevan los servicios en el equipo.

Funciona:

- Redes bridge propias, publicación de puertos y NAT. Al principio solo podía usar `--network host`; con este kernel mis servicios ya corren en una red bridge propia.
- Interfaces macvlan e ipvlan, y la tabla NAT de IPv6.
- Aislamiento de procesos: dentro del contenedor, el primer proceso es el PID 1.
- `overlay2` sobre ext4.
- Un servidor multimedia, su base de datos y otros servicios corriendo meses seguidos.

No funciona:

> [!FAIL]
> - `--memory` y `--pids-limit` se ignoran. Docker avisa ("Limitation discarded") y sigue. Un proceso de 150 MB dentro de un contenedor con límite de 64 MB vivió sin problema.
> - `--cpus` da error, y `--cpuset-cpus` y `--cpu-shares` se descartan con un aviso.
> - `docker stats` muestra ceros.

Lo curioso es que el kernel sí soporta esos límites: `/proc/cgroups` tiene `memory`, `cpu`, `pids` y `cpuset` activos, y existe `cpu.cfs_quota_us`. El problema es Android: monta sus cgroups v1 por separado (en `/dev/memcg`, `/dev/cpuctl`, `/dev/cpuset`…) y además monta un cgroup v2 en `/sys/fs/cgroup` sin ningún controlador. Docker ve el v2, no encuentra nada y descarta los límites. Con `cpuset` hay un choque extra: Android lo monta con la opción `noprefix` (archivos `cpus` en vez de `cpuset.cpus`) y Docker espera lo contrario.

Se podría intentar darle a `dockerd` su propio espacio de montaje con cgroups v1 a su gusto, pero no lo he hecho: tocar cómo Android monta sus cgroups puede romper la forma en que prioriza las apps. Mientras tanto, cuido la RAM con un guardián propio (parte 4). La conclusión práctica: aquí un contenedor desbocado puede comerse el teléfono entero, así que hay que vigilarlo por fuera.

### Otras cosas que conviene saber

El calor es el límite real. El teléfono no tiene ventilador. En reposo los núcleos están entre 43 y 56 °C. Con los 8 núcleos al 100 % llega a 82-85 °C en 15 segundos, y a los 45 segundos los núcleos grandes ya bajaron de ~2 GHz a ~1 GHz para enfriarse. Veinte segundos después de soltar la carga vuelve a ~47 °C. Sirve para cargas a ratos, no para compilar durante horas.

El kernel no trae CIFS ni NFS (los protocolos para montar discos de red), así que uso rclone en espacio de usuario, con lo que eso cuesta en velocidad. La parte 3 va de eso.

El "load average" miente. En Android sube a valores absurdos por hilos del kernel y por montajes FUSE (sistemas de archivos que corren como un programa normal) esperando E/S (entrada/salida), aunque la CPU esté ociosa. Mira el porcentaje de inactividad y el consumo por proceso.

El primer arranque con el kernel nuevo asusta. `dockerd` tardó varios minutos porque `containerd` tenía que limpiar procesos huérfanos viejos, y mi supervisor lo mataba antes de que terminara. Subir su tiempo de espera de 60 a 240 segundos lo resolvió.

## Créditos

Nada de esto es mío desde cero:

- ProtonKernel / Proton+ y EliteGalaxy, por el kernel base del Exynos 2100.
- TurboRCT, por OrangeFox para el S21 FE.
- phh, por las GSI de phh-treble.
- FreddieOliveira, por la guía de Docker nativo en Android, que fue mi referencia directa.
- La comunidad del foro del S21 FE en XDA, por las guías de root, recovery, GSI y `vbmeta`.
- Magisk, Termux y el proyecto Moby.

## Enlaces

- Mi fork del kernel: [parziva-1/Proton](https://github.com/parziva-1/Proton) (rama `proton-main`)
- Kernel original: [ProtonKernel/Proton](https://github.com/ProtonKernel/Proton)
- Hilo de Proton+ en XDA: [Proton Kernel para Exynos 2100](https://xdaforums.com/t/kernel-exynos2100-proton-kernel.4700246/)
- Foro del S21 FE en XDA: [Samsung Galaxy S21 FE](https://xdaforums.com/f/samsung-galaxy-s21-fe.12389/)
- Guía de Docker nativo en Android: [gist de FreddieOliveira](https://gist.github.com/FreddieOliveira/efe850df7ff3951cb62d74bd770dce27)
