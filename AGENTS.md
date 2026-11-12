# RuntimeClips — Manual de Orquestación para Agentes de IA

Bienvenido a **RuntimeClips**. Este documento es la especificación técnica y contrato operativo para que cualquier **Agente de IA** (Antigravity, Claude Code, Cursor, Copilot, etc.) pueda orquestar, inspeccionar, editar y ejecutar el pipeline autónomo de generación de Reels y TikToks verticales 9:16.

---

## 1. Filosofía AI-First

1. **Separación Clara de Roles:**
   - **Lo que calcula la máquina (Determinista):** Descarga de videos, normalización 1080p 30 fps, transcripción local, centrado facial UltraFace ONNX, renderizado FFmpeg, normalización de audio a -14 LUFS, empaquetado ZIP y auditoría de QA.
   - **Lo que decide la IA (Editorial y Creativo):** Selección de ganchos virales, redacción de `storyboard.json` (intención comunicativa de cada escena), refinamiento de copies, llamadas a la acción (CTA) y hashtags.
2. **Inmutabilidad:**
   - La IA **NUNCA** edita a mano archivos temporales generados por scripts (como `clip.mp4` o `captions.ass`). En su lugar, la IA modifica los archivos de definición (`storyboard.json`, `brands/<cuenta>.json`) y vuelve a disparar la etapa correspondiente.
3. **Observabilidad en Tiempo Real:**
   - Todas las ejecuciones reportan telemetría por Server-Sent Events (SSE) y el servidor local en `http://localhost:3000` refleja visualmente el grafo en árbol en vivo.

---

## 2. Protocolo de Ejecución Canónico en 5 Pasos

```
[1. Ingesta & Análisis] ──> [2. Juicio Editorial IA] ──> [3. Árbol de Render] ──> [4. QA Gatekeeper] ──> [5. Entrega Social]
```

### Paso 1: Ingesta y Extracción de Ganchos
El agente recibe una URL de YouTube o ruta local y ejecuta:
```bash
node src/cli/agent_analyze.mjs --url "https://youtu.be/..." [--minScore 0.40]
```
* **Salida JSON:** Devuelve el identificador de ejecución (`runId`), la duración del video, el número de ventanas evaluadas y la lista de todos los clips virales candidatos con 0% de solapamiento (`hooks_candidates.json`).

### Paso 2: Juicio Editorial y Storyboard de la IA
El agente lee `projects/<runId>/hook.json` y los clips candidatos. La IA puede:
- Seleccionar los mejores clips (ej. Top 3 o Todos).
- Ajustar el título de cada gancho.
- Generar opcionalmente un `storyboard.json` para definir qué arquetipo gráfico (`kinetic-title`, `stat-counter`, `comparison`, `quote-card`, `step-list`) mostrar en cada tramo de 3 a 6 segundos.

### Paso 3: Renderizado Concurrente en Árbol
El agente dispara la bifurcación paralela:
```bash
node src/cli/agent_render.mjs --runId <runId> [--workers 2] [--clipLimit 5]
```
* **Salida:** Ejecuta concurrentemente las ramas de cada clip (`reframe` $\to$ `overlays` $\to$ `captions` $\to$ `render`), produce los videos finales en `renders/` y genera el paquete comprimido maestro `renders/<slug>-all-clips.zip`.

### Paso 4: Auditoría Técnica y Visual de QA (Gatekeeper)
El agente ejecuta el gate de calidad obligatorio:
```bash
node src/cli/agent_qa.mjs --runId <runId>
```
* **Salida JSON:** Devuelve el reporte `qa-report.json` con el veredicto para cada clip:
  * **LISTO:** Cumple estrictamente con 1080×1920, 30 fps, H.264/AAC, -14 LUFS (True Peak $\le -1\text{ dBTP}$), frame inicial activo y safe zones.
  * **BLOQUEA:** Si algún check falla, la IA recibe el motivo exacto medido vs esperado para corregir.
* **Inspección Visual:** Genera `contact-sheet.jpg` (tira horizontal 1080x640 con 3 fotogramas clave) para que la IA multimodal inspeccione la estética y legibilidad sin descargar el video entero.

### Paso 5: Paquete Social y Entrega
El agente compila el manifiesto para publicación:
```bash
node src/cli/agent_social.mjs --runId <runId>
```
* **Salida:** Genera `social-pack.json` con titular gancho, copy formateado para Instagram/TikTok, 10 hashtags virales optimizados por nicho y timestamp recomendado para portada.

---

## 3. Esquemas JSON de Entrada y Salida

### `storyboard.json` (Opcional, escrito por la IA):
```json
{
  "clipId": "clip-01",
  "scenes": [
    {
      "id": "scene-01",
      "start": 0.0,
      "end": 4.5,
      "kicker": "MENTALIDAD",
      "title": "¿Sabías que el 90% comete este error?",
      "intent": "hook",
      "archetype": "kinetic-title"
    },
    {
      "id": "scene-02",
      "start": 5.0,
      "end": 9.5,
      "kicker": "DATO CLAVE",
      "title": "10 Millones",
      "intent": "stat",
      "archetype": "stat-counter",
      "visualData": { "number": 10000000, "suffix": "$", "label": "en un día" }
    }
  ]
}
```

### `qa-report.json` (Emitido por el Gatekeeper):
```json
{
  "file": "clip-01.mp4",
  "verdict": "LISTO",
  "pass": true,
  "metrics": {
    "resolution": "1080x1920",
    "fps": 30.0,
    "integratedLufs": -14.2,
    "truePeak": -2.1,
    "durationSec": 42.5
  }
}
```

---

## 4. Zonas Seguras y Reglas de Oro

1. **Márgenes Inviolables:**
   - Superior: `y < 270 px` (Reservado para UI de usuario y audio).
   - Inferior: `y > 1388 px` (Reservado para copy, hashtags y botón de audio).
   - Lateral derecho: `x > 960 px` desde `y = 1100 px` (Botones de Like/Comentar).
   - **Zona Segura de Texto:** `x: 65 a 1015 px`, `y: 270 a 1248 px`.
2. **Subtítulos Karaoke:**
   - Ubicados entre `y = 1248 px` y `1388 px`.
   - Altura de letra $\ge 40\text{ px}$.
   - Contraste WCAG 2.x $\ge 4.5:1$ garantizado por caja o contorno.
