"""
Separador de pistas de RiPlay. Corre con el Python del motor (stems-engine), no con el de RiPlay.

  python stems_worker.py info                       -> placa de video, procesador, versiones
  python stems_worker.py prefetch MODELO            -> baja el modelo (la primera vez)
  python stems_worker.py separate ENTRADA SALIDA MODELO DISPOSITIVO

Escribe en stdout líneas "PROGRESS 0.42" y, al final, "RESULT {json}".
Con --fake no usa Demucs: arma pistas con filtros de ffmpeg (solo para pruebas de RiPlay).
"""
from __future__ import annotations

import json
import math
import os
import platform
import subprocess
import sys
import time
from pathlib import Path

os.environ.setdefault("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", "1")  # los modelos de Demucs no cargan con weights_only
SR = 44100
SILENT_DB = -50.0
FAKE = "--fake" in sys.argv
ARGS = [a for a in sys.argv[1:] if a != "--fake"]


def say(kind: str, payload) -> None:
    print(f"{kind} {payload if isinstance(payload, (int, float, str)) else json.dumps(payload)}", flush=True)


def cpu_name() -> str:
    name = platform.processor() or ""
    if sys.platform == "win32":
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as k:
                name = winreg.QueryValueEx(k, "ProcessorNameString")[0].strip()
        except OSError:
            pass
    elif Path("/proc/cpuinfo").exists():
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                name = line.split(":", 1)[1].strip()
                break
    return name


def info() -> dict:
    out = {"cpu": cpu_name(), "threads": os.cpu_count() or 1, "python": platform.python_version(), "fake": FAKE}
    if FAKE:
        return {**out, "device": "cpu", "gpu": None, "torch": "fake"}
    import torch
    out["torch"] = torch.__version__
    if torch.cuda.is_available():
        out["device"] = "cuda"
        out["gpu"] = torch.cuda.get_device_name(0)
        out["vram"] = round(torch.cuda.get_device_properties(0).total_memory / 2**30, 1)
    else:
        out["device"] = "cpu"
        out["gpu"] = None
    return out


# ---------------------------------------------------------------- audio (PyAV)

def load_audio(path: str):
    import av
    import numpy as np
    chunks = []
    with av.open(path) as container:
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=SR)
        for frame in container.decode(stream):
            for f in resampler.resample(frame):
                chunks.append(f.to_ndarray())
        for f in resampler.resample(None):
            chunks.append(f.to_ndarray())
    if not chunks:
        raise RuntimeError("El archivo no tiene audio")
    return np.concatenate(chunks, axis=1).astype("float32")


def save_m4a(path: Path, data) -> Path:
    """AAC 192 kbps en .m4a (lo reproduce cualquier navegador). Si falla, WAV de 16 bits."""
    import numpy as np
    data = np.clip(data, -1.0, 1.0).astype("float32")
    try:
        import av
        with av.open(str(path), "w", format="mp4") as out:
            st = out.add_stream("aac", rate=SR, layout="stereo")
            st.bit_rate = 192_000
            step = SR  # 1 segundo por cuadro; el codificador lo reparte en cuadros de AAC
            for i in range(0, data.shape[1], step):
                frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(data[:, i:i + step]), format="fltp", layout="stereo")
                frame.sample_rate = SR
                for pkt in st.encode(frame):
                    out.mux(pkt)
            for pkt in st.encode(None):
                out.mux(pkt)
        return path
    except Exception as exc:  # noqa: BLE001
        print(f"WARN no se pudo guardar AAC ({exc}); guardo WAV", file=sys.stderr, flush=True)
        import soundfile as sf
        wav = path.with_suffix(".wav")
        sf.write(str(wav), data.T, SR, subtype="PCM_16")
        path.unlink(missing_ok=True)
        return wav


def level_db(data) -> float:
    import numpy as np
    rms = float(np.sqrt(np.mean(np.square(data, dtype="float64")))) if data.size else 0.0
    return 20 * math.log10(rms) if rms > 0 else -120.0


# ---------------------------------------------------------------- Demucs

def get_model(name: str):
    from demucs.pretrained import get_model as _get
    model = _get(name)
    model.eval()
    return model


def separate(src: str, out_dir: str, model_name: str, device: str) -> dict:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    if FAKE:
        return fake_separate(src, out, t0)
    import numpy as np
    import torch
    import demucs.apply as dapply

    threads = max(1, (os.cpu_count() or 2) - 1)  # deja un núcleo libre para que la música no se corte
    torch.set_num_threads(threads)
    if device == "cuda" and not torch.cuda.is_available():
        device = "cpu"

    wav = load_audio(src)
    duration = wav.shape[1] / SR
    t_load = time.time()
    say("PROGRESS", 0.02)

    model = get_model(model_name)
    model.to(device)

    class _Progress:  # Demucs muestra el avance con tqdm: se reemplaza para avisarle a RiPlay
        @staticmethod
        def tqdm(iterable, **_kw):
            items = list(iterable)
            for i, item in enumerate(items):
                yield item
                say("PROGRESS", round(0.03 + 0.92 * (i + 1) / max(1, len(items)), 3))
    dapply.tqdm = _Progress

    t = torch.from_numpy(wav)
    ref = t.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        res = dapply.apply_model(model, ((t - mean) / std)[None], device=device, shifts=1, split=True,
                                 overlap=0.25, progress=True, num_workers=0)[0]
    res = (res * std + mean).cpu().numpy()
    t_sep = time.time()

    sources = []
    for name, data in zip(model.sources, res):
        db = level_db(data)
        item = {"name": name, "db": round(db, 1), "silent": db < SILENT_DB}
        if not item["silent"]:
            item["file"] = save_m4a(out / f"{name}.m4a", data).name
        sources.append(item)
    say("PROGRESS", 1.0)
    t_end = time.time()
    return {
        "ok": True, "model": model_name, "device": device, "threads": threads, "duration": round(duration, 2),
        "sources": sources,
        "timings": {"load": round(t_load - t0, 2), "separate": round(t_sep - t_load, 2),
                    "encode": round(t_end - t_sep, 2), "total": round(t_end - t0, 2)},
    }


# ---------------------------------------------------------------- modo de prueba

FAKE_FILTERS = {
    "drums": "highpass=f=4000,volume=1.5",
    "bass": "lowpass=f=180,volume=1.2",
    "other": "bandpass=f=600:width_type=h:w=400",
    "vocals": "bandpass=f=1500:width_type=h:w=900",
    "guitar": "bandpass=f=2500:width_type=h:w=1000",
    "piano": "volume=0",
}


def fake_separate(src: str, out: Path, t0: float) -> dict:
    delay = float(os.environ.get("RIPLAY_STEMS_FAKE_DELAY", "0.15"))
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src],
                               capture_output=True, text=True, check=True).stdout.strip() or 0)
    if "fail" in Path(src).name or os.environ.get("RIPLAY_STEMS_FAKE_FAIL"):
        raise RuntimeError("falla de prueba del separador")
    for i in range(1, 11):
        time.sleep(delay)
        say("PROGRESS", round(0.03 + 0.9 * i / 10, 3))
    sources = []
    for name, af in FAKE_FILTERS.items():
        if name == "piano":
            sources.append({"name": name, "db": -120.0, "silent": True})
            continue
        dest = out / f"{name}.webm"  # Opus: el Chromium de las pruebas no trae AAC
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-af", af, "-ac", "2", "-ar", "48000",
                        "-c:a", "libopus", "-b:a", "96k", str(dest)], check=True)
        sources.append({"name": name, "db": -20.0, "silent": False, "file": dest.name})
    say("PROGRESS", 1.0)
    total = time.time() - t0
    return {"ok": True, "model": "fake", "device": "cpu", "threads": 1, "duration": round(dur, 2), "sources": sources,
            "timings": {"load": 0.1, "separate": round(total - 0.2, 2), "encode": 0.1, "total": round(total, 2)}}


def main() -> int:
    try:
        cmd = ARGS[0] if ARGS else ""
        if cmd == "info":
            say("RESULT", {"ok": True, **info()})
        elif cmd == "prefetch":
            if not FAKE:
                get_model(ARGS[1])
            say("RESULT", {"ok": True, **info()})
        elif cmd == "separate":
            say("RESULT", separate(ARGS[1], ARGS[2], ARGS[3], ARGS[4]))
        else:
            print(__doc__)
            return 2
        return 0
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        say("RESULT", {"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
