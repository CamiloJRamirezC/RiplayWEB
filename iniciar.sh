#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
  echo "No encontré Python 3. Instalalo desde https://www.python.org/downloads/"
  exit 1
fi

if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "Tu Python es muy viejo ($(python3 --version)). RiPlay necesita 3.10 o más nuevo."
  exit 1
fi

if [ ! -x ".venv/bin/python" ]; then
  echo "Preparando RiPlay por primera vez, tarda un minuto..."
  python3 -m venv .venv || { echo "No se pudo crear el entorno de Python."; exit 1; }
fi

echo "Revisando actualizaciones de yt-dlp..."
.venv/bin/python -m pip install -q --disable-pip-version-check -U -r requirements.txt \
  || echo "Sin internet o falló la actualización: sigo con lo que ya está instalado."

if ! .venv/bin/python -c "import yt_dlp, ytmusicapi" 2>/dev/null; then
  echo "Faltan librerías y no se pudieron instalar. Revisá tu internet y volvé a abrir."
  .venv/bin/python -m pip install -r requirements.txt
  exit 1
fi

exec .venv/bin/python server.py
