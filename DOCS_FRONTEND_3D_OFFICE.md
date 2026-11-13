# RuntimeClips — Especificación de Diseño de la Oficina Agéntica 3D (Arquitectura en Árbol)

> **Blueprint Técnico y Visual** para el desarrollo del nuevo frontend de RuntimeClips.  
> Adaptado a la **Arquitectura en Árbol (Fork/Join)**: tronco común de ingesta, bifurcación en paralelo por clips, empaquetador ZIP y sala de cine multi-clip.

---

## 1. Visión y Concepto Dinámico

La **Oficina Agéntica 3D** ahora refleja la topología viva en árbol del pipeline:
* **Área Central (Tronco Común):** Las primeras 4 estaciones de trabajo fijas operan de forma secuencial (`input` → `ingest` → `transcribe` → `hook`).
* **Bahía de Producción Multi-Clip (Bifurcación en Paralelo):** Al completarse el nodo `hook`, la oficina recibe el evento SSE `graph_expanded`. En ese instante, los puestos de producción visual se activan en paralelo para cada clip descubierto (mostrando en sus pantallas el progreso individual de Reframe, Overlays, Captions y Render de cada clip mediante un Worker Pool).
* **Zona de Logística y Empaquetado (`collector`):** Un agente robot o cinta transportadora holográfica recibe los clips listos y los sella en una caja digital `.ZIP`.
* **Sala de Cine y Cartelera (`player`):** Gran auditorio con pantalla de proyección que reproduce el clip seleccionado, un carrusel 3D con todos los clips calificados por virabilidad y un botón holográfico para descargar el paquete `.zip` completo.

```
+---------------------------------------------------------------------------------------------------------+
| [RuntimeClips] [🏷️ Brand: default ▼] [URL / Local Input ......] [▶ Generar] [🧪 Mock] [🔊] [🏢 3D | 📊 Grafo] |
+---------------------------------------------------------------------------------------------------------+
|                                                                                                         |
|       [Estación 01: Recepción]         [Estación 02: Ingesta]          [Estación 03: Transcripción]     |
|          (Agente Nexus)                   (Agente Byte)                    (Agente Echo)                |
|                                                                                                         |
|                                [Estación 04: Dirección / Hook]                                          |
|                                        (Agente Viral)                                                   |
|                                               |                                                         |
|             +---------------------------------+---------------------------------+                       |
|             | (Bifurcación Paralela)          |                                 |                       |
|             v                                 v                                 v                       |
|      [Rama Clip #1]                    [Rama Clip #2]                    [Rama Clip #3...]              |
|  (Reframe->Overlays->Render)       (Reframe->Overlays->Render)       (Reframe->Overlays->Render)        |
|             |                                 |                                 |                       |
|             +---------------------------------+---------------------------------+                       |
|                                               |                                                         |
|                                [Estación 05: Empaquetador ZIP]                                          |
|                                       (Agente Collector)                                                |
|                                               |                                                         |
|                                [Estación 06: Sala de Cine Multi-Clip]                                   |
|                                       (Agente Showcase)                                                 |
|                                                                                                         |
+---------------------------------------------------------------------------------------------------------+
|  [Consola de Logs en Vivo SSE]                                                           [Drawer Node]  |
+---------------------------------------------------------------------------------------------------------+
```

---

## 2. Los Agentes y Roles del Estudio en Árbol

| # | Fase | Clave Nodo | Nombre Agente | Rol en el Estudio | Color de Neón | Avatar Voxel & Accesorios | Elementos del Puesto y Pantalla Canvas |
|---|---|---|---|---|---|---|---|
| **01** | Tronco | `input` | **NEXUS** | Recepcionista & Gatekeeper | `#CCDDEE` Plata | Traje sastre gris marengo, gafete magnético de recepción. | Mostrador curvo. Monitor con validador de URLs. |
| **02** | Tronco | `ingest` | **BYTE** | Archivista & Especialista de Ingesta | `#00F0FF` Cyan | Sudadera con capucha, collar con memoria USB. | Discos duros y antenas. Monitor con velocímetro de descarga `yt-dlp`. |
| **03** | Tronco | `transcribe` | **ECHO** | Lingüista & Especialista de Audio | `#7C4DFF` Violeta | Camisa casual, auriculares circumaurales de estudio. | Sala acústica. Monitor con forma de onda y texto tipeado Parakeet. |
| **04** | Tronco | `hook` | **VIRAL** | Director Editorial & Selector | `#FF9100` Ámbar | Gorra de director hacia atrás, chaleco de realizador. | Mesa de director con storyboard. Monitor con curvas de retención y clips elegidos. |
| **05** | Ramas | `reframe-*` | **FOCUS** | Operador de Cámara & Tracking | `#00E676` Verde | Gafas técnicas, chaleco táctico verde militar. | Trípode con cámara 9:16 robotizada y visor facial UltraFace. |
| **06** | Ramas | `overlays-*` | **VECTOR** | Animador Motion Graphics | `#E040FB` Magenta | Boina de artista, suéter geométrico y tablet digitalizadora. | Mesa de diseño digital con timelines GSAP y paletas de color. |
| **07** | Ramas | `captions-*` | **TYPO** | Tipógrafo & Letrista Karaoke | `#FFEA00` Amarillo | Gafas redondas, tirantes vintage y reloj de muñeca dorado. | Teclado mecánico con iluminación RGB y resaltado karaoke. |
| **08** | Ramas | `render-*` | **MASTER** | Ingeniero de Render & Audio QA | `#FF3366` Carmesí | Visor protector carmesí, guantes térmicos aislantes. | Racks de servidores con luces estroboscópicas y medidor LUFS (-14 dB). |
| **09** | Join | `collector` | **BOXER** | Operador Logístico & ZIP | `#FF6600` Naranja | Mono de trabajo industrial, gorra de almacén y escáner láser. | Zona de carga con cinta transportadora y caja digital holográfica `.zip`. |
| **10** | Join | `player` | **SHOWCASE** | Proyeccionista & Sala de Cine | `#0DEEF3` Turquesa | Traje casual elegante, gafas de sol retro y palomitas. | Sala de cine con butacas de terciopelo, pantalla gigante y cartelera de clips. |

---

## 3. Manejo de la Bifurcación en Three.js (`event: graph_expanded`)

Cuando el backend emite `graph_expanded`, la escena 3D no se reconstruye desde cero (para no causar lag ni fugas de VRAM):

1. **Expansión de Bahías Visuales:**
   - La oficina amplía dinámicamente las mesas de la zona de renderizado o activa pantallas auxiliares para los $N$ clips seleccionados.
   - Cada monitor de rama dibuja en su propio canvas 2D el progreso de su clip (`progress: 0..1`).
2. **Dron Mensajero en Abanico (Fan-Out):**
   - Desde el escritorio del Director Viral (nodo `hook`), se disparan $N$ mini-drones holográficos simultáneamente hacia las ramas de los clips activos.
3. **Convergencia al Collector (Fan-In):**
   - Conforme cada rama de clip completa su renderizado (`render-${cid}`), su dron vuela con el carrete de película MP4 hacia el escritorio de **BOXER** (`collector`).
   - Al llegar el último clip, la caja ZIP se sella con un destello brillante y un acorde armónico Web Audio API.

---

## 4. Sala de Cine Multi-Clip (Estación `player`)

- **Pantalla Gigante:** Proyecta en bucle con textura WebGL el clip activo seleccionado.
- **Cartelera Interactiva:** Debajo de la pantalla se despliega el carrusel de tarjetas de clips virales descubiertos (`#1`, `#2`, `#3` con su título, duración y virabilidad `%`).
- **Botón de Descarga ZIP:** Botón holográfico prominente `[ 📦 Descargar Todos (.ZIP) ]` que apunta a `output.zipUrl`.
- **Selector de Clips:** Clic en cualquier tarjeta cambia instantáneamente la proyección de la pantalla grande y actualiza los metadatos sin recargar la página.

---

## 5. Reglas de Rendimiento WebGL (60 FPS)

- **InstancedMesh:** Las butacas del cine, sillas de oficina y estructuras de monitores se instancian para mantener los draw calls por debajo de 100 independientemente de cuántos clips se procesen.
- **Worker Pool UI:** Solo se animan intensamente los nodos de las ramas que estén en estado `running` en ese milisegundo (respetando la concurrencia de workers del backend).
