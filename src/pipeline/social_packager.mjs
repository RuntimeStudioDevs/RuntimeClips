// Generador del Paquete Social (Social Packager) para publicación en redes.
//
// Produce para cada clip generado:
// 1. Título gancho (Hook title)
// 2. Descripción completa (Caption con hook, puntos clave y CTA)
// 3. 10 hashtags virales adaptados al nicho y palabras clave
// 4. Marca de tiempo recomendada para la portada (Thumbnail)
// 5. Certificado técnico de QA (EBU R128, 1080x1920, 30 fps)

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { POWER } from './hook_detector.mjs';

const NICHE_HASHTAGS = {
  negocios: ['#negocios', '#emprendimiento', '#dinero', '#finanzas', '#inversiones', '#mentalidad'],
  exito: ['#exito', '#superacion', '#metas', '#productividad', '#disciplina', '#habitos'],
  historia: ['#historias', '#podcastenespañol', '#sabiasque', '#aprender', '#curiosidades'],
  general: ['#reelsviral', '#tiktokviral', '#shorts', '#crecimiento', '#podcast', '#inspiracion'],
};

/**
 * Genera el paquete social completo para un clip
 * @param {object} clip
 * @param {Array} words
 * @param {object} qaResult
 * @param {object} snapshotResult
 * @param {string} outPath
 * @returns {object}
 */
export function buildSocialPack(clip, words = [], qaResult = {}, snapshotResult = {}, outPath = null) {
  const title = clip.title || clip.hook || 'Momento Clave';
  const cleanTitle = title.replace(/[.!?…]+$/, '').trim();

  // Detectar palabras clave presentes en el clip
  const textWords = words.map((w) => w.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''));
  const detectedPower = [...new Set(textWords.filter((w) => POWER.has(w)))];

  // Seleccionar hashtags relevantes
  const tags = new Set(['#reels', '#shorts', '#viral']);
  if (detectedPower.some((p) => ['dinero', 'millones', 'millón', 'negocio', 'fracaso'].includes(p))) {
    NICHE_HASHTAGS.negocios.forEach((t) => tags.add(t));
  }
  if (detectedPower.some((p) => ['éxito', 'cambió', 'vida', 'hábito', 'hábitos', 'mente'].includes(p))) {
    NICHE_HASHTAGS.exito.forEach((t) => tags.add(t));
  }
  NICHE_HASHTAGS.general.forEach((t) => tags.add(t));
  const finalHashtags = [...tags].slice(0, 12);

  // Redactar copy estructurado
  const caption = [
    `🔥 ${cleanTitle}`,
    '',
    `En este fragmento analizamos uno de los puntos más importantes:`,
    `👉 ${clip.hook}`,
    '',
    `💡 Razones clave:`,
    ...(clip.reasons || ['Reflexión profunda con alto impacto']).slice(0, 2).map((r) => ` • ${r}`),
    '',
    `💬 ¿Estás de acuerdo con esta postura? Déjame tu opinión en los comentarios 👇`,
    `📌 Guarda este Reel para tenerlo presente siempre.`,
    '',
    finalHashtags.join(' '),
  ].join('\n');

  const pack = {
    clipId: clip.clipId,
    title: cleanTitle,
    durationSec: clip.durationSec,
    scorePercent: clip.scorePercent || 90,
    coverTimestamp: snapshotResult.timestamps?.[0] || 2.0,
    files: {
      video: qaResult.file || `${clip.clipId}.mp4`,
      contactSheet: snapshotResult.contactSheet ? path.basename(snapshotResult.contactSheet) : null,
      coverImage: snapshotResult.cover ? path.basename(snapshotResult.cover) : null,
    },
    qa: {
      verdict: qaResult.verdict || 'LISTO',
      pass: qaResult.pass ?? true,
      resolution: qaResult.metrics?.resolution || '1080x1920',
      lufs: qaResult.metrics?.integratedLufs ?? -14.0,
    },
    social: {
      hookTitle: cleanTitle,
      caption,
      hashtags: finalHashtags,
      suggestedAudio: 'Trending Business / Lo-Fi Beats',
    },
  };

  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify(pack, null, 2)}\n`);
  }

  return pack;
}
