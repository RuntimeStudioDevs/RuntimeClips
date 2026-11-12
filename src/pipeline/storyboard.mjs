// Parser y validador de Storyboards Semánticos para orquestación de IA.
//
// Permite que un Agente de IA planifique visualmente la narrativa de un clip
// dividiéndolo en escenas con arquetipos GSAP deliberados:
// - kinetic-title  (Gancho tipográfico impactante)
// - stat-counter   (Contador numérico animado)
// - comparison     (Tarjeta comparativa antes vs ahora)
// - quote-card     (Frase o cita célebre destacada)
// - step-list      (Paso o consejo secuencial 1, 2, 3)
// - keyword-badge  (Píldora destacada de palabra clave)

export const VALID_ARCHETYPES = [
  'kinetic-title',
  'stat-counter',
  'comparison',
  'quote-card',
  'step-list',
  'keyword-badge',
];

/**
 * Valida un objeto storyboard.json
 * @param {object} board
 * @param {number} totalDurationSec
 * @returns {{ valid: boolean, errors: string[], warnings: string[], scenes: Array }}
 */
export function validateStoryboard(board, totalDurationSec = Infinity) {
  const errors = [];
  const warnings = [];

  if (!board || typeof board !== 'object') {
    return { valid: false, errors: ['El storyboard debe ser un objeto JSON'], warnings: [], scenes: [] };
  }

  const rawScenes = Array.isArray(board.scenes) ? board.scenes : [];
  if (!rawScenes.length) {
    return { valid: false, errors: ['El storyboard no contiene escenas (array "scenes" vacío)'], warnings: [], scenes: [] };
  }

  const scenes = [...rawScenes].sort((a, b) => a.start - b.start);
  const seenIds = new Set();
  let cursor = 0;

  scenes.forEach((scene, index) => {
    const id = scene.id || `scene-${String(index + 1).padStart(2, '0')}`;
    if (seenIds.has(id)) {
      errors.push(`ID de escena repetido: "${id}"`);
    }
    seenIds.add(id);

    if (typeof scene.start !== 'number' || scene.start < 0) {
      errors.push(`Escena "${id}": "start" debe ser un número >= 0`);
    }
    if (typeof scene.end !== 'number' || scene.end <= scene.start) {
      errors.push(`Escena "${id}": "end" (${scene.end}) debe ser mayor que "start" (${scene.start})`);
    }
    if (scene.end > totalDurationSec + 0.5) {
      errors.push(`Escena "${id}": termina en ${scene.end}s, después del final del clip (${totalDurationSec}s)`);
    }

    if (scene.start < cursor - 0.1) {
      errors.push(`Escena "${id}" (${scene.start}s) se solapa con la anterior (${cursor}s)`);
    } else if (scene.start > cursor + 1.5) {
      warnings.push(`Hueco de ${scene.start - cursor}s antes de escena "${id}": el video no tendrá overlay activo`);
    }
    cursor = scene.end;

    if (scene.archetype && !VALID_ARCHETYPES.includes(scene.archetype)) {
      warnings.push(`Arquetipo desconocido "${scene.archetype}" en escena "${id}". Se usará "kinetic-title" por defecto.`);
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    scenes,
  };
}

/**
 * Genera un storyboard semántico preliminar a partir de las palabras y ganchos de un clip
 */
export function generateDefaultStoryboard(clip, words) {
  const duration = clip.durationSec;
  const scenes = [];

  // Escena 1: El Gancho inicial (0.0s a ~4.5s)
  scenes.push({
    id: 'scene-01',
    start: 0.0,
    end: Math.min(4.5, duration * 0.25),
    kicker: 'CLAVE VIRAL',
    title: clip.title || clip.hook,
    intent: 'hook',
    archetype: 'kinetic-title',
  });

  // Escenas intermedias basadas en contenido
  let currentStart = Math.min(5.0, duration * 0.3);
  let sceneIndex = 2;

  // Buscar cifras en las palabras del cuerpo
  const numberWord = words.find((w) => w.start > currentStart && w.start < duration * 0.7 && /\d+/.test(w.text));
  if (numberWord) {
    const sStart = Math.max(currentStart, numberWord.start - 0.5);
    const sEnd = Math.min(sStart + 4.0, duration * 0.8);
    scenes.push({
      id: `scene-${String(sceneIndex++).padStart(2, '0')}`,
      start: Number(sStart.toFixed(2)),
      end: Number(sEnd.toFixed(2)),
      kicker: 'DATO IMPACTO',
      title: numberWord.text,
      intent: 'stat',
      archetype: 'stat-counter',
      visualData: { number: Number(numberWord.text.replace(/[^\d.]/g, '') || 100), label: 'Cifra revelada' },
    });
    currentStart = sEnd + 1.0;
  }

  // Escena de Cierre / Call to Action
  if (duration - currentStart >= 4.0) {
    scenes.push({
      id: `scene-${String(sceneIndex++).padStart(2, '0')}`,
      start: Number(currentStart.toFixed(2)),
      end: Number((duration - 0.5).toFixed(2)),
      kicker: 'REGLA DE ORO',
      title: 'Guarda y comparte este Reel',
      intent: 'cta',
      archetype: 'keyword-badge',
    });
  }

  return {
    clipId: clip.clipId,
    durationSec: duration,
    scenes,
  };
}
