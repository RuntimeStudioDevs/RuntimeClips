# RuntimeClips 🎬⚡

> **Estudio Autónomo de Generación de Clips 9:16 a Pantalla Completa con Observabilidad Gráfica estilo n8n.**  
> *Procesamiento 100% local, centrado facial con IA, subtítulos karaoke, animaciones motion graphics y telemetría en tiempo real.*

---

## 🌟 Características Principales

* 🔒 **100% Local y Privado:** Tus videos, transcripciones y audios nunca se envían a APIs en la nube. Todo el procesamiento corre en tu hardware local.
* 🤖 **100% Autónomo:** Pega una URL de YouTube (o pasa un archivo local) y el sistema se encarga de todo: descarga, transcripción, detección de ganchos virales (30–60 s), reencuadre facial, composición y render.
* 🎙️ **Motor Multi-Clip para Podcasts y Videos Largos (1h+):** Analiza horas completas de video y extrae automáticamente el **máximo número de clips virales no solapados** (entre 5 y 25 clips de alto impacto ordenados por puntuación de virabilidad).
* 🎨 **Brand Kits Corporativos (`brands/*.json`):** Personalización completa de marca con colores corporativos, tipografía y cálculo de contraste WCAG $\ge$ 4.5:1.
* 📱 **Pantalla Completa Real (9:16 - 1080×1920):** **Sin pantalla dividida**. El video del orador llena todo el fondo con seguimiento facial inteligente (UltraFace ONNX) y cortes multicámara automáticos.
* ✨ **Motion Graphics Transparentes (GSAP):** Titulares cinéticos, barras de progreso, cifras con conteo animado, badges, tarjetas de comparación A/B, listas de pasos y citas destacadas superpuestas dinámicamente según el guion.
* 💬 **Subtítulos Dinámicos Karaoke:** Agrupamiento de 2–4 palabras con resaltado temporal sincronizado palabra por palabra y contraste optimizado para celulares.
* 📊 **Dashboard Visual Observable (Estilo n8n):** Interfaz web moderna (`http://localhost:3000`) con un grafo interactivo de **9 nodos conectados por cables curvos SVG**, galería de clips descubiertos con puntuación individual, pulsos luminosos de flujo de datos, streaming de logs por Server-Sent Events (SSE), drawer de inspección de telemetría y reproductor de video final integrado.
* 🔊 **Masterización de Audio Profesional:** Normalización EBU R128 a **-14 LUFS** (±1 LUFS) con True Peak **$\le$ -1 dBTP** (especificación estricta de Instagram Reels, TikTok y YouTube Shorts).

---

## 🗺️ Arquitectura del Pipeline de 9 Nodos

El pipeline está desacoplado en 9 etapas secuenciales conectadas al orquestador central (`src/pipeline/orchestrator.mjs`):

```
+---------------------------------------------------------------------------------------------------------------+
|                                            RUNTIMECLIPS PIPELINE                                              |
|                                                                                                               |
|  [01: Input]       --> [02: Ingest & Probe] --> [03: Local Transcribe] --> [04: Hook & Clip Selector]        |
|  (URL / Local)         (yt-dlp + FFmpeg)        (Parakeet / Whisper)       (Scoring de 30-60 s)               |
|                                                                                        |                      |
|                                                                                        v                      |
|  [08: Render & QA] <-- [07: Karaoke Captions] <-- [06: Motion Overlays] <-- [05: Full-Screen Reframe]        |
|  (FFmpeg -14 LUFS)     (Alineación palabra)     (Capas transparentes)      (UltraFace ONNX 9:16)              |
|         |                                                                                                     |
|         v                                                                                                     |
|  [09: Final Player] --> MP4 1080x1920 Listo para publicar en Instagram / TikTok / Shorts                     |
+---------------------------------------------------------------------------------------------------------------+
```

| Nodo | Icono | Módulo | Responsabilidad |
|---|---|---|---|
| **01. Input** | 🔗 | `src/pipeline/orchestrator.mjs` | Valida origen (YouTube URL o ruta de archivo local existente). |
| **02. Ingest & Probe** | ⬇️ | `src/pipeline/downloader.mjs` | Descarga con `yt-dlp`, sondea metadatos con `ffprobe` y normaliza a 30 fps estables. |
| **03. Local Transcribe** | 🎙️ | `src/pipeline/transcriber.mjs` | Extrae audio WAV mono 16 kHz y transcribe en local con marcas de tiempo en milisegundos. |
| **04. Hook Selector** | 🎯 | `src/pipeline/hook_detector.mjs` | Evalúa apertura, densidad de palabras de poder, ritmo y cierre para aislar los mejores 30–60 s. |
| **05. Full-Screen Reframe** | 🧑 | `src/pipeline/reframe.mjs` | Detecta cortes de plano y centra el rostro en el tercio superior (`y=700`) usando UltraFace ONNX. |
| **06. Motion Overlays** | ✨ | `src/pipeline/overlays.mjs` | Planifica e inyecta capas GSAP (titulares, contadores de números, barras de avance). |
| **07. Karaoke Captions** | 💬 | `src/pipeline/captions.mjs` | Genera la composición HTML de subtítulos agrupados con efecto karaoke en la zona segura. |
| **08. Render & QA** | 🎬 | `src/pipeline/renderer.mjs` | Renderiza los fotogramas y normaliza el audio a -14 LUFS con True Peak $\le$ -1 dBTP. |
| **09. Final Player** | ▶️ | `public/app.js` | Emite el evento de finalización, monta el video en el reproductor web y habilita la descarga. |

---

## 🚀 Requisitos Previos

Necesitas tener instalados en tu sistema:
1. **Node.js** (versión 22 o superior).
2. **FFmpeg & ffprobe** (para procesamiento y normalización de medios).
3. **yt-dlp** (para descarga de videos de YouTube y redes).
4. **Deno** (necesario para que `yt-dlp` resuelva firmas de YouTube sin bloqueos de bot).

### Instalación rápida de dependencias del sistema:

* **Windows (PowerShell):**
  ```powershell
  winget install OpenJS.NodeJS.LTS
  winget install Gyan.FFmpeg
  winget install yt-dlp.yt-dlp
  winget install DenoLand.Deno
  ```

* **macOS (Homebrew):**
  ```bash
  brew install node ffmpeg yt-dlp deno
  ```

* **Linux (Debian/Ubuntu):**
  ```bash
  sudo apt update && sudo apt install -y ffmpeg curl
  # Node.js 22+ desde nodejs.org
  sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp
  curl -fsSL https://deno.land/install.sh | sh
  ```

---

## 🛠️ Instalación y Puesta en Marcha

### 1. Clonar el repositorio
```bash
git clone https://github.com/RuntimeStudioDevs/RuntimeClips.git
cd RuntimeClips
```

### 2. Instalar dependencias de Node
```bash
npm install
```

### 3. Configuración inicial única
El script de setup verifica las herramientas del sistema y descarga los modelos locales necesarios (detector de caras UltraFace ONNX y dependencias de HyperFrames):
```bash
npm run setup
```

### 4. Iniciar el Dashboard visual
```bash
npm start
```
Abre tu navegador en:
👉 **`http://localhost:3000`**

---

## 💻 Uso por Línea de Comandos (CLI)

Si prefieres ejecutar el pipeline directamente desde la terminal o integrarlo en scripts de automatización:

```bash
# Proceso automático completo desde YouTube
npm run clip -- "https://www.youtube.com/watch?v=TU_VIDEO"

# Con un archivo local
npm run clip -- "C:/videos/mi-grabacion.mp4"

# Modo borrador rápido (render rápido para validar)
npm run clip -- "https://www.youtube.com/watch?v=TU_VIDEO" --draft

# Forzar una ventana de tiempo específica (segundos)
npm run clip -- "https://www.youtube.com/watch?v=TU_VIDEO" --start 45 --end 95

# Especificar idioma de transcripción
npm run clip -- "https://www.youtube.com/watch?v=TU_VIDEO" --lang en
```

---

## 🐳 Despliegue con Docker

RuntimeClips incluye soporte nativo de contenedor para despliegue inmediato en servidores Linux o VPS:

```bash
docker compose up -d --build
```
El estudio estará disponible inmediatamente en `http://localhost:3000` (o la IP pública de tu servidor), mapeando los videos generados a la carpeta `./renders`.

---

## 🤖 Guía Técnica para Agentes de IA (Claude, Codex, Cursor, Gemini)

Si eres un **agente de inteligencia artificial** que va a trabajar, extender o mantener este repositorio, lee atentamente esta sección:

### Estructura del Código
```
RuntimeClips/
├── server.mjs                  # Servidor Express: API REST y bus SSE
├── public/                     # Frontend Vanilla sin bundlers (HTML5/CSS3/ESM)
│   ├── index.html              # Canvas SVG y drawer de telemetría
│   ├── app.js                  # Manejador del grafo n8n, pan/zoom y EventSource
│   └── styles.css              # Tema Cyberpunk/Dark Terminal con variables CSS
├── src/
│   ├── pipeline/
│   │   ├── tools.mjs           # Localizador de binarios de sistema y constantes
│   │   ├── downloader.mjs      # Ingesta y normalización 30 fps
│   │   ├── transcriber.mjs     # Transcripción local por palabras
│   │   ├── hook_detector.mjs   # Heurística de scoring y power-words
│   │   ├── reframe.mjs         # Inferencia ONNX (UltraFace) y keyframing
│   │   ├── overlays.mjs        # Generador de subcomposiciones GSAP
│   │   ├── captions.mjs        # Agrupador de palabras y estilo karaoke
│   │   ├── renderer.mjs        # Compositor headless y filtro loudnorm EBU R128
│   │   └── orchestrator.mjs    # Motor de ejecución secuencial de los 9 nodos
│   └── template/
│       ├── index.html          # Template maestro 1080x1920 con capas z-index
│       ├── compositions/       # HTML de overlays (badges, counters, kinetic titles)
│       └── assets/             # Fuentes WOFF2 locales y GSAP bundled
├── scripts/
│   └── setup.mjs               # Verificador de entorno y descargador de modelos
├── models/                     # Modelos ONNX descargados (en .gitignore)
├── projects/                   # Proyectos temporales generados (en .gitignore)
└── renders/                    # Videos MP4 finales producidos (en .gitignore)
```

### Protocolo de Telemetría por Server-Sent Events (SSE)
El servidor expone `GET /api/pipeline/stream`. Cada nodo emite eventos tipados consumidos por el dashboard:
* **`event: node`**: Parchea el estado de un nodo:
  ```json
  { "key": "hook", "status": "running", "progress": 0.45, "data": { ... } }
  ```
* **`event: log`**: Envía líneas de log en vivo para la consola inferior:
  ```json
  { "id": 142, "ts": 1700000000, "level": "info", "node": "reframe", "message": "UltraFace: 4 caras detectadas" }
  ```
* **`event: pipeline`**: Actualiza el estado global (`idle`, `running`, `completed`, `error`).

### Reglas Invariables de Producción
1. **Zonas Seguras Verticales:**
   * La cara del orador debe orbitar alrededor de `y=700` (tercio superior).
   * La banda de overlays dinámicos reside en `y: 880–1060`.
   * Los subtítulos residen en `y: 1070–1230`.
   * Los últimos 600 px inferiores deben mantenerse despejados de textos para no colisionar con la descripción y botones de Instagram/TikTok.
2. **Audio Mastering:**
   * El filtro FFmpeg debe garantizar: `-af loudnorm=I=-14:TP=-1:LRA=11` o limitador con True Peak $\le$ -1.0 dBTP.
3. **Independencia de Red en Render:**
   * Las plantillas en `src/template/` nunca deben invocar CDNs externos (Google Fonts, unpkg, cdnjs). Todos los activos (fuentes Inter y `gsap.min.js`) están empaquetados localmente en `src/template/assets/`.

### Cómo Extender Nuevos Overlays
Para añadir un nuevo efecto visual:
1. Agrega la plantilla HTML en `src/template/compositions/tu-efecto.html`.
2. Define la lógica de activación por palabras clave en `src/pipeline/overlays.mjs`.
3. Inyéctalo en la composición maestro dentro de `src/pipeline/renderer.mjs`.

---

## 📄 Licencia

Este proyecto está bajo la licencia **MIT**. Puedes usarlo, modificarlo y distribuirlo libremente para proyectos personales o comerciales.
