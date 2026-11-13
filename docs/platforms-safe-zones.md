# Zonas Seguras de Plataformas: Instagram Reels, TikTok y YouTube Shorts

- **Actualización:** 2026-11-12
- **Aplicado en:** RuntimeClips (`src/pipeline/reframe.mjs`, `src/pipeline/captions.mjs`, `src/pipeline/overlays.mjs`, `src/pipeline/qa_auditor.mjs`).

---

## 1. Especificaciones de Formato Universal 9:16

| Parámetro | Valor de RuntimeClips | Compatibilidad de Plataformas |
| :--- | :--- | :--- |
| **Relación de Aspecto** | **9:16** | 100% nativo vertical en Instagram, TikTok, Shorts |
| **Resolución** | **1080×1920 px** | Estándar de alta fidelidad para Reels y TikTok |
| **Framerate** | **30 fps** (o 60 fps en acción rápida) | Constante (CFR), nunca variable (VFR) |
| **Códec de Video** | **H.264 (`yuv420p`)** | Compatible sin re-codificación agresiva |
| **Códec de Audio** | **AAC 48 kHz Estéreo** | 160 kbps, calidad estudio móvil |
| **Sonoridad EBU R128** | **-14 LUFS ± 1 LUFS** | True Peak $\le -1.0\text{ dBTP}$ (evita distorsión en celulares) |
| **Duración Óptima** | **30 a 60 segundos** | Retención máxima de audiencia y completitud narrativa |

---

## 2. Zonas Seguras (1080×1920 px)

Para evitar que los elementos de interfaz de las aplicaciones móviles (nombre de usuario, descripción, botones de Like, comentarios y pista de audio) tapen el contenido esencial o el rostro del hablante:

```
y = 0     +------------------------------------------+
          |  MARGEN UI SUPERIOR (Sin texto)   270 px |  <- Header de usuario, etiqueta de audio
y = 270   |------------------------------------------|
          |                                          |
          |  ZONA SEGURA PRINCIPAL                   |  <- Títulos kinéticos, arquetipos GSAP,
          |  Texto y gráficos: x 65 - 1015           |     rostro centrado (UltraFace ONNX)
          |                                          |
y = 1248  |------------------------------------------|
          |  ZONA DE SUBTÍTULOS KARAOKE      140 px  |  <- Subtítulos en caja con contraste WCAG 2.x
y = 1388  |------------------------------------------|
          |  MARGEN UI INFERIOR               532 px |  <- Título de canción, copy, hashtags, CTA
y = 1920  +------------------------------------------+
```

### Márgenes Críticos:
* **Margen Superior (14 % = 270 px):** Prohibido ubicar texto o elementos interactivos; aquí se ubica la cabecera del perfil y el buscador.
* **Margen Inferior (28-35 % = 532 a 672 px):** Espacio reservado para la descripción del video, música y stickers. Los subtítulos se sitúan inmediatamente arriba de esta zona (`y ≈ 1248–1388 px`).
* **Columna de Interacción Derecha (desde `y ≈ 1100 px`, ancho 120 px):** `x > 960 px`. Zona de botones flotantes (Like, Comentar, Compartir, Guardar).
* **Zona de Seguridad de Texto:** `x: 65 a 1015 px`, `y: 270 a 1248 px`.

---

## 3. Criterio de Auditoría de Accesibilidad (WCAG 2.x)

* **Tamaño Tipográfico:**
  * Títulos de impacto: 80 a 96 px.
  * Subtítulos karaoke: Altura de letra $\ge 44\text{ px}$ (fuente $\ge 56\text{ px}$). En una pantalla de 6.1" se lee con total claridad a 30 cm.
* **Ratio de Contraste:**
  * Mínimo **4.5:1** (WCAG AA) entre el texto del subtítulo y el fondo o la caja de respaldo.
  * Para colores acento brillantes sobre fondo oscuro: $\ge 7:1$ (WCAG AAA).
