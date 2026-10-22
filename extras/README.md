# Extras

`riplay-android-descargas.patch`: parche para la app Android original
([fast4x/RiPlay](https://github.com/fast4x/RiPlay)) que agrega la opción
"Descargar al dispositivo" en el menú de cada canción. Guarda el audio en `Música/RiPlay`
usando NewPipe Extractor y MediaStore.

Se aplica sobre una copia del repositorio de RiPlay:

```bash
git apply riplay-android-descargas.patch
./gradlew :androidApp:assembleDebug
```

No fue compilado (se verificó contra la API de NewPipe Extractor v0.26.0 y que aplica limpio).
