// Test unitario integral para las nuevas herramientas de QA, Storyboard y Social Packager.

import assert from 'node:assert';
import { validateStoryboard, generateDefaultStoryboard } from '../src/pipeline/storyboard.mjs';
import { buildSocialPack } from '../src/pipeline/social_packager.mjs';
import { auditClip } from '../src/pipeline/qa_auditor.mjs';

console.log('🧪 Iniciando prueba de Herramientas de QA y Agentes de IA...\n');

// ── Test 1: Validación de Storyboards Semánticos ─────────────────────────────
{
  console.log('📋 Test 1: Storyboard Semántico y Escenas');

  // Caso A: Storyboard válido
  const validBoard = {
    clipId: 'clip-01',
    scenes: [
      { id: 'scene-01', start: 0.0, end: 4.5, intent: 'hook', archetype: 'kinetic-title', title: 'Gran Secreto' },
      { id: 'scene-02', start: 4.8, end: 12.0, intent: 'stat', archetype: 'stat-counter', title: '10M $' },
      { id: 'scene-03', start: 12.2, end: 28.0, intent: 'quote', archetype: 'quote-card', title: 'La verdad es...' },
    ],
  };
  const valResult = validateStoryboard(validBoard, 30.0);
  assert.strictEqual(valResult.valid, true, 'El storyboard válido debe pasar');
  assert.strictEqual(valResult.errors.length, 0, 'No debe haber errores');
  console.log('  ✔ Storyboard válido: APROBADO');

  // Caso B: Detección de solapamiento y tiempos inválidos
  const invalidBoard = {
    clipId: 'clip-02',
    scenes: [
      { id: 'scene-01', start: 5.0, end: 2.0 }, // end < start
      { id: 'scene-01', start: 1.0, end: 6.0 }, // ID repetido y solapado
    ],
  };
  const errResult = validateStoryboard(invalidBoard, 30.0);
  assert.strictEqual(errResult.valid, false, 'El storyboard inválido debe ser rechazado');
  assert(errResult.errors.length >= 2, 'Debe reportar múltiples errores de tiempo y repetición');
  console.log(`  ✔ Detección de errores en Storyboard: APROBADO (${errResult.errors.length} errores capturados)`);

  // Caso C: Generación de Storyboard por defecto a partir de clip
  const mockClip = { clipId: 'clip-01', durationSec: 42.0, title: '¿Sabías esto?' };
  const mockWords = [
    { text: '¿Sabías', start: 0.5, end: 1.2 },
    { text: 'perdimos', start: 15.0, end: 15.6 },
    { text: '1000000', start: 15.8, end: 16.5 },
    { text: 'dólares', start: 16.6, end: 17.2 },
  ];
  const autoBoard = generateDefaultStoryboard(mockClip, mockWords);
  assert.strictEqual(autoBoard.scenes.length >= 2, true, 'Debe generar al menos 2 escenas');
  console.log(`  ✔ Generación automática de Storyboard: APROBADO (${autoBoard.scenes.length} escenas generadas)\n`);
}

// ── Test 2: Generación del Paquete Social (Social Packager) ─────────────────
{
  console.log('📋 Test 2: Paquete Social (Copies, Títulos, Hashtags)');

  const mockClip = {
    clipId: 'clip-01',
    title: '¿Sabías que el 90% comete este grave error con su dinero?',
    hook: 'Nadie te dice la verdad sobre el dinero y el éxito real.',
    durationSec: 42.5,
    scorePercent: 93,
    reasons: ['Abre con pregunta intrigante', 'Cifra de impacto al inicio'],
  };
  const mockWords = [
    { text: 'dinero' },
    { text: 'millones' },
    { text: 'éxito' },
    { text: 'negocio' },
  ];
  const mockQa = {
    file: 'clip-01.mp4',
    verdict: 'LISTO',
    pass: true,
    metrics: { resolution: '1080x1920', integratedLufs: -14.1 },
  };
  const mockSnap = {
    contactSheet: 'renders/clip-01-contact-sheet.jpg',
    cover: 'renders/clip-01-cover.jpg',
    timestamps: [2.0, 21.0, 36.0],
  };

  const pack = buildSocialPack(mockClip, mockWords, mockQa, mockSnap);

  assert.strictEqual(pack.clipId, 'clip-01');
  assert(pack.social.caption.includes('🔥 ¿Sabías que el 90% comete este grave error con su dinero'));
  assert(pack.social.hashtags.length >= 8, 'Debe incluir al menos 8 hashtags relevantes');
  assert(pack.social.hashtags.includes('#dinero') || pack.social.hashtags.includes('#finanzas'), 'Debe incluir hashtags de nicho de dinero');
  assert.strictEqual(pack.qa.verdict, 'LISTO');
  assert.strictEqual(pack.files.video, 'clip-01.mp4');

  console.log('  ✔ Paquete social generado con éxito:');
  console.log(`     - Título: "${pack.social.hookTitle}"`);
  console.log(`     - Hashtags (${pack.social.hashtags.length}): ${pack.social.hashtags.slice(0, 6).join(' ')}...`);
  console.log(`     - QA Verdict: ${pack.qa.verdict} (LUFS: ${pack.qa.lufs})\n`);
}

// ── Test 3: Interfaz del Auditor de QA ───────────────────────────────────────
{
  console.log('📋 Test 3: Auditor de QA');
  assert.strictEqual(typeof auditClip, 'function', 'auditClip debe ser una función exportada');
  console.log('  ✔ Auditor de QA: Módulo exportado y disponible.\n');
}

console.log('🎉 ¡TODOS LOS TESTS DE QA Y HERRAMIENTAS DE AGENTES PASARON EXITOSAMENTE!');
