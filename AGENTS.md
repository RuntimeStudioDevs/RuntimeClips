# RuntimeClips — Guía para Agentes de IA

Este proyecto unifica el pipeline autónomo local de 9 nodos para generación de clips verticales (9:16) con una **Oficina Agéntica 3D interactiva** observable en tiempo real.

## 1. Convenciones y Reglas del Proyecto

- **Entorno y Ejecución:** 100% local y privado (servidor Express en `http://localhost:3000`).
- **Rama de Trabajo Frontend:** `feature/frontend-3d-office`.
- **Arquitectura de Frontend:** Módulos ES nativos en `public/3d/` (Three.js + GSAP) sin bundlers pesados para arranque instantáneo.
- **Rendimiento:** 60 FPS estricto en WebGL (`draw calls < 100` con `InstancedMesh`, capping de DPR a 2, canvas textures sin fugas de VRAM).
- **Diseño Sonoro:** Síntesis procedural nativa con Web Audio API (cero descargas de audio externas).

## 2. Skills Activas en el Repositorio (`.agents/skills/`)

1. **`better-ui`:** Pautas de interfaces táctiles, micro-interacciones y transiciones de alto craft.
2. **`frontend-design`:** Enfoque anti-slop, dirección estética intencional, tipografía distintiva y paletas de alto contraste.
3. **`frontend-ui-engineering`:** Patrones de ingeniería frontend, rendimiento, accesibilidad y layouts robustos.
4. **`threejs-skills`:** Guía moderna de Three.js (r160+/r186), cámaras isométricas, batching, raycasting y shader architecture.
