// Test unitario integral: Extracción máxima de clips en videos de cualquier duración
// (5 min, 10 min, 15 min, 20 min, 100+ min) SIN reducir la duración de los clips.

import { detectHook, detectAllHooks } from '../src/pipeline/hook_detector.mjs';

console.log('🧪 Iniciando prueba integral de Universal Clip Maximizer...\n');

const VIRAL_SAMPLES = [
  '¿Sabías que el 90% de las personas comete este grave error con su dinero?',
  'Imagina descubrir el secreto que cambió por completo mi vida y mi carrera.',
  'Nadie te dice la verdad sobre el éxito real y el esfuerzo que requiere.',
  '¿Cuál es el mayor peligro de no tomar una decisión radical hoy mismo?',
  'Resulta que la ciencia demostró una sorpresa absolutamente brutal e impactante.',
  'Mira este truco increíble que transformó mi productividad para siempre.',
  'Nunca jamás permitas que el miedo te impida alcanzar tu libertad.',
  'Esto es una locura total: descubrimos cómo resolver el problema en minutos.',
  '¿Por qué casi nadie habla de esta regla fundamental para el futuro?',
  'La clave principal que aprendí tras años de estudio y experimentación.',
];

function generateMockTranscript(durationMinutes, viralDensity = 1.0) {
  const words = [];
  const sentences = [];
  let timeCursor = 2.0;
  let sentenceIdx = 0;
  const totalSeconds = durationMinutes * 60;
  let hookIndex = 0;

  while (timeCursor < totalSeconds - 8) {
    const currentMin = Math.floor(timeCursor / 60);
    // Cada ~1.5 minutos intercalamos un gancho viral potente
    const isViral = (sentenceIdx % 6 === 0) && Math.random() < viralDensity;
    let text;
    if (isViral) {
      text = VIRAL_SAMPLES[hookIndex % VIRAL_SAMPLES.length];
      hookIndex++;
    } else {
      text = `En este momento del minuto ${currentMin} profundizamos en los detalles y análisis del proyecto.`;
    }

    const tokens = text.split(/\s+/);
    const sStart = timeCursor;
    for (const token of tokens) {
      const wStart = timeCursor;
      timeCursor += 0.35;
      const wEnd = timeCursor;
      words.push({ text: token, start: wStart, end: wEnd });
    }
    const sEnd = timeCursor;
    sentences.push({
      index: sentenceIdx++,
      text,
      start: sStart,
      end: sEnd,
      firstWord: words.length - tokens.length,
      lastWord: words.length - 1,
    });

    timeCursor += 1.2; // Pausa natural
  }

  return { words, sentences, durationSec: timeCursor };
}

function verifyClips(clips, label, minExpectedClips, minSec = 30, maxSec = 60) {
  console.log(`\n📋 Evaluando caso: ${label}`);
  console.log(`  - Clips extraídos: ${clips.length} (Mínimo esperado: ${minExpectedClips})`);

  if (clips.length < minExpectedClips) {
    throw new Error(`❌ FALLÓ [${label}]: Se esperaban al menos ${minExpectedClips} clips, se obtuvieron ${clips.length}`);
  }

  // 1. Verificación de Duración: NINGÚN clip debe tener duración reducida (< minSec)
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (c.durationSec < minSec - 0.5) {
      throw new Error(`❌ FALLÓ [${label}]: Clip #${i + 1} tiene duración reducida (${c.durationSec}s < ${minSec}s)`);
    }
    if (c.durationSec > maxSec + 0.5) {
      throw new Error(`❌ FALLÓ [${label}]: Clip #${i + 1} excede duración máxima (${c.durationSec}s > ${maxSec}s)`);
    }
  }
  console.log(`  ✔ Duración de clips respetada: Todos los clips están entre ${minSec}s y ${maxSec}s (sin clips recortados).`);

  // 2. Verificación de No-Solapamiento: 0% de superposición
  for (let i = 0; i < clips.length; i++) {
    for (let j = i + 1; j < clips.length; j++) {
      const a = clips[i];
      const b = clips[j];
      const overlapStart = Math.max(a.startSec, b.startSec);
      const overlapEnd = Math.min(a.endSec, b.endSec);
      if (overlapEnd > overlapStart + 0.05) {
        throw new Error(`❌ FALLÓ [${label}]: Solapamiento entre Clip #${i + 1} (${a.startSec}-${a.endSec}) y Clip #${j + 1} (${b.startSec}-${b.endSec})`);
      }
    }
  }
  console.log('  ✔ Solapamiento 0%: Ningún clip comparte tiempo con otro.');

  // Mostrar muestra de clips
  const sample = clips.slice(0, 4);
  sample.forEach((c, idx) => {
    console.log(`     [${c.clipId}] ${c.startClock} → ${c.endClock} (${c.durationSec}s) · Score ${c.scorePercent}% · "${c.title}"`);
  });
  if (clips.length > 4) {
    console.log(`     ... y ${clips.length - 4} clips más.`);
  }
}

// ── Test 1: Video Corto de 5 Minutos (300 s) ─────────────────────────────────
{
  const transcript = generateMockTranscript(5);
  const result = detectHook({
    words: transcript.words,
    sentences: transcript.sentences,
    durationSec: transcript.durationSec,
    options: { minScore: 0.40 },
  });
  // En 5 minutos (~300s), con clips de 35-45s, se esperan entre 4 y 7 clips
  verifyClips(result.clips, 'Video Corto (5 minutos)', 4);
}

// ── Test 2: Video Medio de 15 Minutos (900 s) ────────────────────────────────
{
  const transcript = generateMockTranscript(15);
  const result = detectHook({
    words: transcript.words,
    sentences: transcript.sentences,
    durationSec: transcript.durationSec,
    options: { minScore: 0.40 },
  });
  // En 15 minutos (~900s), se esperan al menos 12 clips
  verifyClips(result.clips, 'Video Medio (15 minutos)', 12);
}

// ── Test 3: Podcast Largo de 100 Minutos (6000 s) ────────────────────────────
{
  const transcript = generateMockTranscript(100);
  const result = detectHook({
    words: transcript.words,
    sentences: transcript.sentences,
    durationSec: transcript.durationSec,
    options: { minScore: 0.40 },
  });
  // En 100 minutos (~6000s), el motor no debe tener tope artificial de 25 clips
  // Se esperan más de 60 clips virales sin solapamiento
  verifyClips(result.clips, 'Podcast Largo (100 minutos)', 60);
  console.log(`  🎉 ¡Total clips en 100 minutos!: ${result.clips.length} clips extraídos (superó con creces cualquier límite anterior).`);
}

// ── Test 4: Modo Single (1 solo clip principal si se pide explícitamente) ───────
{
  const transcript = generateMockTranscript(10);
  const result = detectHook({
    words: transcript.words,
    sentences: transcript.sentences,
    durationSec: transcript.durationSec,
    options: { single: true },
  });
  if (result.clips.length !== 1) {
    throw new Error(`❌ FALLÓ: En options.single se esperaba 1 clip, se obtuvieron ${result.clips.length}`);
  }
  console.log(`\n✔ Modo options.single=true: Retorna exactamente 1 clip principal con el mayor score (${result.scorePercent}%).`);
}

// ── Test 5: Límite explícito maxClips ─────────────────────────────────────────
{
  const transcript = generateMockTranscript(20);
  const result = detectHook({
    words: transcript.words,
    sentences: transcript.sentences,
    durationSec: transcript.durationSec,
    options: { maxClips: 3 },
  });
  if (result.clips.length !== 3) {
    throw new Error(`❌ FALLÓ: Con options.maxClips=3 se esperaban 3 clips, se obtuvieron ${result.clips.length}`);
  }
  console.log('✔ Modo options.maxClips=3: Limita exactamente a 3 clips cuando el usuario lo especifica.');
}

console.log('\n🎉 ¡TODAS LAS PRUEBAS DE UNIVERSAL CLIP MAXIMIZER PASARON EXITOSAMENTE!');
