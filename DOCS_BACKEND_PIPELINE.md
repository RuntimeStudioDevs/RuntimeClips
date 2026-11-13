# RuntimeClips — Manual Técnico de Arquitectura en Árbol (Fork/Join) y Pipeline Backend

> **Documento de Referencia Oficial** para el equipo de desarrollo de RuntimeClips.  
> Describe la nueva arquitectura en árbol con bifurcación paralela multi-clip (Fan-Out / Fan-In), empaquetado ZIP maestro, herramientas locales, modelos de IA, APIs REST y el protocolo de eventos Server-Sent Events (SSE).

---

## 1. Visión y Principios del Sistema

1. **100% Local y Privado:** No se envían videos, transcripciones ni audios a servidores externos. Todo el procesamiento (transcripción Parakeet, detección facial UltraFace ONNX, renderizado HyperFrames y masterización FFmpeg) corre localmente en el hardware del equipo.
2. **100% Autónomo con Arquitectura en Árbol:** A partir de una sola URL o archivo de entrada, el sistema analiza el video completo y genera automáticamente múltiples clips virales no solapados procesados en paralelo mediante un **Worker Pool con concurrencia acotada**.
3. **Convergencia y Empaquetado ZIP:** Al terminar las ramas de renderizado, un nodo colector (`collector`) empaqueta todos los clips en un único archivo comprimido `.zip` y el reproductor (`player`) permite visualización individual y descarga completa.

---

## 2. Topología del Pipeline en Árbol (Fork/Join)

```mermaid
flowchart TD
    subgraph FASE 1: Tronco Común (Trunk)
        N1["01: Input\n(Validación)"] --> N2["02: Ingest & Probe\n(yt-dlp + FFmpeg)"]
        N2 --> N3["03: Local Transcribe\n(Parakeet ONNX)"]
        N3 --> N4["04: Hook Selector\n(Detección Multi-Clip)"]
    end

    subgraph FASE 2: Bifurcación Paralela (Fan-Out por Clip)
        N4 --> R1["Reframe #1\n(UltraFace)"] --> O1["Overlays #1\n(GSAP)"] --> C1["Captions #1\n(Karaoke)"] --> RD1["Render #1\n(-14 LUFS)"]
        N4 --> R2["Reframe #2\n(UltraFace)"] --> O2["Overlays #2\n(GSAP)"] --> C2["Captions #2\n(Karaoke)"] --> RD2["Render #2\n(-14 LUFS)"]
        N4 --> R3["Reframe #3\n(UltraFace)"] --> O3["Overlays #3\n(GSAP)"] --> C3["Captions #3\n(Karaoke)"] --> RD3["Render #3\n(-14 LUFS)"]
    end

    subgraph FASE 3: Convergencia (Fan-In)
        RD1 --> COL["ZIP Packager\n(collector)"]
        RD2 --> COL
        RD3 --> COL
        COL --> PLY["Multi-Clip Player\n(player)"]
    end
```

### Detalle Técnico de las Fases

#### Fase 1: Tronco Común (Trunk Stages)
* **`input`:** Valida URL de YouTube o archivo local.
* **`ingest`:** Descarga con `yt-dlp` (usando `deno`), sondea metadatos con `ffprobe` y normaliza a 30 FPS estables.
* **`transcribe`:** Extrae audio WAV mono 16 kHz y ejecuta el modelo local Parakeet generando tokens y timestamps.
* **`hook`:** Evalúa virabilidad heurística y genera la lista completa de clips candidatos no solapados (`clips: [...]`).

#### Fase 2: Bifurcación Concurrente (Fan-Out)
* El orquestador emite `emit.expandGraph()` por SSE, multiplicando los nodos y cables hacia cada rama de clip.
* Se ejecuta un **Worker Pool** (`runWorkerPool(targetClips, concurrency)`) con límite configurable (`--workers 2` por defecto, ajustable hasta 6).
* Para cada clip independiente:
  1. `reframe-${clipId}`: Centrado facial 9:16 (1080×1920) a 4 fps con UltraFace ONNX.
  2. `overlays-${clipId}`: Planificación de motion graphics en GSAP para ese tramo.
  3. `captions-${clipId}`: Subtítulos karaoke sincronizados en la zona segura.
  4. `render-${clipId}`: Renderizado con Chromium headless y masterización a -14 LUFS.

#### Fase 3: Convergencia (Fan-In)
* **`collector` (`src/pipeline/packager.mjs`):** Empaqueta todos los archivos `.mp4` generados en un archivo maestro `.zip` usando `tar` del sistema o `Compress-Archive` de PowerShell.
* **`player` (`public/app.js`):** Monta el reproductor multi-clip con selector individual, badges de puntuación viral y botón de descarga del `.zip` completo.

---

## 3. Protocolo de Eventos SSE en Árbol

El servidor emite eventos SSE a `GET /api/pipeline/stream`:

1. **`event: snapshot`**  
   Envía el estado actual con `{ pipeline, nodes, edges, logs }`.
2. **`event: graph_expanded`** *(NUEVO)*  
   Emitido tras la fase `hook` cuando el árbol se bifurca. Envía la nueva lista completa de nodos de ramas (`reframe-${cid}`, `overlays-${cid}`, etc.), los cables conectados y el número total de ramas.
3. **`event: node`**  
   Actualiza estado (`running`, `progress`, `completed`, `error`) de un nodo específico del tronco o de una rama.
4. **`event: log`**  
   Envía líneas de log identificando el clip y nodo emisor (ej. `[Clip #2] Reframe 9:16 completado`).
5. **`event: pipeline`**  
   Notifica la finalización global con `output.zipUrl`, `output.totalClips` y `output.clips`.
