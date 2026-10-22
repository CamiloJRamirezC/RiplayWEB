# RiPlay Web (local)

Reproductor de música personal que corre en tu compu y se usa desde el navegador.
Busca en YouTube Music, reproduce, arma listas y descarga canciones a una carpeta tuya.

## Qué necesitás

Solo internet. **No hace falta instalar nada antes:** si tu compu no tiene Python 3.10 o más
nuevo, `iniciar.bat` lo instala solo (para tu usuario, sin pedir permisos de administrador).
No hace falta ffmpeg ni ninguna cuenta. Lo descargado se escucha sin internet.

## Cómo abrirlo

- **Windows:** doble clic en `iniciar.bat`.
- **Mac / Linux:** en una terminal, `./iniciar.sh` (ahí sí necesitás Python 3.10+ instalado).

Lo que hace `iniciar.bat`:

1. Busca Python 3.10 o más nuevo. Si ya está, sigue de largo.
2. Si no está, lo instala con winget o, si no hay winget, con el instalador oficial de python.org.
3. Prepara RiPlay la primera vez (tarda un minuto) y actualiza **yt-dlp** en cada arranque:
   YouTube cambia seguido y esa actualización es lo que mantiene funcionando la reproducción y las
   descargas.
4. Inicia el servicio y, cuando ya responde, abre RiPlay en tu navegador predeterminado.

Si RiPlay ya estaba abierto, solo abre el navegador. Mientras lo uses dejá abierta la ventana
negra; cerrala para apagarlo.

## Cómo se usa

- **Buscar:** escribí y apretá Buscar (o Enter). Podés elegir Canciones o Videos.
  Si YouTube Music no responde, busca automáticamente en YouTube normal.
- **Reproducir:** clic en el título. "Reproducir todo" carga la lista entera en la cola.
- **Menú ⋯ de cada canción:** reproducir a continuación, agregar a la cola, iniciar radio
  (canciones parecidas), descargar y agregar a una lista.
- **Listas:** en la barra lateral, **Nueva lista** crea una vacía. También desde el menú ⋯ de
  cualquier canción → "Nueva lista…" (la crea con esa canción adentro).
- **Importar de Spotify:** pegá el enlace de una playlist o álbum (en Spotify: ⋯ → Compartir →
  Copiar enlace). La lista tiene que ser pública. RiPlay busca cada canción en YouTube y crea la
  lista; al final muestra las que no encontró. Podés cerrar la ventana mientras importa.
  - **Listas privadas o "Me gusta":** en la app de Spotify entrá a la lista, Ctrl+A y Ctrl+C, y
    pegá eso (son enlaces de canciones, uno por línea).
  - También acepta texto `Artista - Canción` (una por línea) o un archivo CSV de exportify.app.
  - Spotify no ofrece esto oficialmente: si un día cambia su página y deja de leer listas
    largas, RiPlay avisa y conviene usar el CSV de Exportify.
- **Cola:** botón de la derecha en el reproductor. Si dejás marcada la opción
  "Seguir con canciones parecidas", al terminar la cola sigue sola.
- **En el disco:** lo que descargaste, la carpeta donde se guarda y el progreso de las descargas.
- **Teclado:** barra espaciadora para pausar, Alt + ← / → para anterior / siguiente.
  Las teclas multimedia del teclado también funcionan.

## Dónde quedan las cosas

- **Canciones descargadas:** `Música/RiPlay` en tu carpeta de usuario (se cambia desde
  "En el disco" → "Cambiar carpeta"). Se guardan en `.m4a` con título, artista, álbum y portada,
  así que cualquier otro reproductor las reconoce.
- **Listas y configuración:** carpeta `RiPlayWeb` en tu usuario (`playlists.json`, `config.json`).
  Copiá esa carpeta para tener un respaldo.

## Si algo falla

- Cada error queda anotado en `RiPlayWeb/riplay.log` (en tu carpeta de usuario). Ese archivo dice qué pasó.
- Si la página muestra **"La búsqueda no puede funcionar todavía"**, seguí lo que indica: casi
  siempre es un Python viejo (hace falta 3.10 o más nuevo) o librerías que no se instalaron.

- **"YouTube pidió verificación anti-bot"** o una canción no carga: cerrá y volvé a abrir con
  `iniciar.bat` para que se actualice yt-dlp. Si sigue, esperá un rato.
- **"El puerto 8765 está ocupado"**: RiPlay ya está abierto en otra ventana.
- Para usar otro puerto: variable de entorno `RIPLAY_PORT` (por ejemplo 8800).

El servidor solo escucha en tu propia compu (127.0.0.1): nadie de tu red puede entrar.

Nota: los términos de uso de YouTube no permiten descargar contenido fuera de sus propias
funciones. Esto está pensado para uso personal.
