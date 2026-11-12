// Test unitario para verificar la selección masiva de clips en videos largos / podcasts.
import { detectHook, detectAllHooks } from '../src/pipeline/hook_detector.mjs';

console.log('🧪 Iniciando prueba de Multi-Clip Hook Detector...\n');

// Simular un podcast de 60 minutos (3600 segundos) con 12 momentos virales distribuidos
const sentences = [];
const words = [];
let timeCursor = 5;

// Palabras de relleno
const filler = ['entonces', 'vamos', 'a', 'revisar', 'lo', 'que', 'pasó', 'en', 'la', 'semana'];

// 10 puntos calientes virales a lo largo de los 60 minutos
const viralHooks = [
  { min: 3, text: '¿Sabías que el 90% de los negocios cometen este grave error?' },
  { min: 8, text: 'Imagina que descubres el secreto para cambiar tu vida por completo.' },
  { min: 15, text: 'Nadie te dice la verdad sobre el dinero y el éxito real.' },
  { min: 22, text: '¿Cuál es el mayor peligro de no actuar hoy mismo?' },
  { min: 30, text: 'Resulta que la ciencia demostró una sorpresa impresionante.' },
  { min: 38, text: 'Mira este truco brutal que cambió mi mentalidad para siempre.' },
  { min: 44, text: 'Nunca jamás permitas que el miedo destruya tu futuro y libertad.' },
  { min: 52, text: 'Esto es una locura: perdimos 10 millones de dólares en un día.' },
];

let sentenceIdx = 0;
for (let minute = 1; minute <= 58; minute++) {
  const isViral = viralHooks.find((h) => h.min === minute);
  const sentenceText = isViral ? isViral.text : `Este es el minuto ${minute} de la conversación sobre temas cotidianos.`;
  const sentenceWords = sentenceText.split(/\s+/);
  const sStart = timeCursor;

  sentenceWords.forEach((w) => {
    const wStart = timeCursor;
    timeCursor += 0.35;
    const wEnd = timeCursor;
    words.push({ text: w, start: wStart, end: wEnd });
  });

  const sEnd = timeCursor;
  sentences.push({
    index: sentenceIdx++,
    text: sentenceText,
    start: sStart,
    end: sEnd,
    firstWord: words.length - sentenceWords.length,
    lastWord: words.length - 1,
  });

  timeCursor += 2.5; // Pausa entre oraciones
}

const totalSec = timeCursor;
console.log(`📊 Transcript generado: ${sentences.length} oraciones, ${words.length} palabras, duración ${(totalSec / 60).toFixed(1)} min.`);

const logLines = [];
const result = detectAllHooks(
  {
    words,
    sentences,
    durationSec: totalSec,
    options: { multi: true, minScore: 0.50, maxClips: 10 },
  },
  { log: (_level, msg) => logLines.push(msg) },
);

console.log(`\n✔ Evaluación completada:`);
console.log(`  - Total clips extraídos: ${result.clips.length}`);
console.log(`  - Ventanas evaluadas: ${result.evaluated}`);

if (!result.clips || result.clips.length < 5) {
  console.error(`❌ FALLÓ: Se esperaban al menos 5 clips en un video de 1h, se obtuvieron ${result.clips.length}`);
  process.exit(1);
}

// Verificar que ningún clip se solape
for (let i = 0; i < result.clips.length; i++) {
  for (let j = i + 1; j < result.clips.length; j++) {
    const a = result.clips[i];
    const b = result.clips[j];
    const overlapStart = Math.max(a.startSec, b.startSec);
    const overlapEnd = Math.min(a.endSec, b.endSec);
    if (overlapEnd > overlapStart) {
      console.error(`❌ FALLÓ: Solapamiento detectado entre Clip #${i + 1} (${a.startSec}-${a.endSec}) y Clip #${j + 1} (${b.startSec}-${b.endSec})`);
      process.exit(1);
    }
  }
}

console.log('✔ Verificación de no-solapamiento: PASADA (0% solapamiento entre clips)');
result.clips.forEach((c, i) => {
  console.log(`  Clip #${i + 1} [${c.startSec.toFixed(1)}s - ${c.endSec.toFixed(1)}s] Score: ${c.scorePercent}% → "${c.title}"`);
});

console.log('\n🎉 ¡Todos los tests de Multi-Clip pasaron exitosamente!');
