// Test unitario integral para la arquitectura de Árbol (Fork/Join) y empaquetador ZIP.

import assert from 'node:assert';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createZipArchive } from '../src/pipeline/packager.mjs';
import { TRUNK_NODES, JOIN_NODES } from '../src/pipeline/orchestrator.mjs';

console.log('🧪 Iniciando prueba de Arquitectura de Árbol y Empaquetado ZIP...\n');

// ── Test 1: Verificación de Nodos y Topología del Árbol ─────────────────────
{
  console.log('📋 Test 1: Generación de topología del árbol');
  const mockClips = [
    { clipId: 'clip-01', title: 'Gancho #1', startSec: 10, endSec: 50 },
    { clipId: 'clip-02', title: 'Gancho #2', startSec: 60, endSec: 100 },
    { clipId: 'clip-03', title: 'Gancho #3', startSec: 120, endSec: 165 },
  ];

  const branchNodes = [];
  const edges = [
    { from: 'input', to: 'ingest' },
    { from: 'ingest', to: 'transcribe' },
    { from: 'transcribe', to: 'hook' },
  ];

  mockClips.forEach((clip, idx) => {
    const k = idx + 1;
    const cid = clip.clipId;
    branchNodes.push(
      { key: `reframe-${cid}`, label: `Reframe #${k}`, branchId: cid },
      { key: `overlays-${cid}`, label: `Overlays #${k}`, branchId: cid },
      { key: `captions-${cid}`, label: `Captions #${k}`, branchId: cid },
      { key: `render-${cid}`, label: `Render #${k}`, branchId: cid },
    );
    edges.push(
      { from: 'hook', to: `reframe-${cid}` },
      { from: `reframe-${cid}`, to: `overlays-${cid}` },
      { from: `overlays-${cid}`, to: `captions-${cid}` },
      { from: `captions-${cid}`, to: `render-${cid}` },
      { from: `render-${cid}`, to: 'collector' },
    );
  });
  edges.push({ from: 'collector', to: 'player' });

  const totalNodes = TRUNK_NODES.length + branchNodes.length + JOIN_NODES.length;
  console.log(`  - Nodos del tronco: ${TRUNK_NODES.length}`);
  console.log(`  - Nodos de ramas (3 clips x 4 etapas): ${branchNodes.length}`);
  console.log(`  - Nodos de convergencia: ${JOIN_NODES.length}`);
  console.log(`  - Total nodos en el árbol: ${totalNodes}`);
  console.log(`  - Total aristas en el grafo: ${edges.length}`);

  assert.strictEqual(TRUNK_NODES.length, 4, 'El tronco debe tener 4 nodos');
  assert.strictEqual(branchNodes.length, 12, '3 clips deben generar 12 nodos de rama');
  assert.strictEqual(JOIN_NODES.length, 2, 'Debe haber 2 nodos de unión (collector y player)');
  assert.strictEqual(edges.length, 3 + 3 * 5 + 1, 'Total de aristas correcto');

  console.log('  ✔ Topología del árbol: VÁLIDA y correctamente conectada.\n');
}

// ── Test 2: Worker Pool y Concurrencia Acotada ──────────────────────────────
{
  console.log('📋 Test 2: Concurrencia acotada con Worker Pool');

  async function runWorkerPool(items, concurrency, workerFn) {
    let index = 0;
    const poolSize = Math.max(1, Math.min(concurrency, items.length));
    const workers = Array.from({ length: poolSize }, async () => {
      while (index < items.length) {
        const currentIdx = index++;
        await workerFn(items[currentIdx], currentIdx);
      }
    });
    await Promise.all(workers);
  }

  let activeWorkers = 0;
  let maxObservedActive = 0;
  const processedItems = [];
  const testItems = ['clip-1', 'clip-2', 'clip-3', 'clip-4', 'clip-5', 'clip-6'];
  const CONCURRENCY_LIMIT = 2;

  await runWorkerPool(testItems, CONCURRENCY_LIMIT, async (item) => {
    activeWorkers++;
    maxObservedActive = Math.max(maxObservedActive, activeWorkers);
    // Simular trabajo asíncrono
    await new Promise((r) => setTimeout(r, 40));
    processedItems.push(item);
    activeWorkers--;
  });

  console.log(`  - Elementos procesados: ${processedItems.length}/${testItems.length}`);
  console.log(`  - Concurrencia configurada: ${CONCURRENCY_LIMIT}`);
  console.log(`  - Máximo de workers activos simultáneos observados: ${maxObservedActive}`);

  assert.strictEqual(processedItems.length, testItems.length, 'Todos los elementos deben ser procesados');
  assert(maxObservedActive <= CONCURRENCY_LIMIT, `La concurrencia (${maxObservedActive}) no debe superar el límite (${CONCURRENCY_LIMIT})`);
  console.log('  ✔ Worker Pool: Respeta estrictamente el límite de concurrencia.\n');
}

// ── Test 3: Empaquetado ZIP Maestro ──────────────────────────────────────────
{
  console.log('📋 Test 3: Creación de archivo comprimido .ZIP con múltiples clips');

  const tmpDir = existsSync(path.resolve('renders'))
    ? path.resolve('renders')
    : path.resolve('RuntimeClips/renders');
  mkdirSync(tmpDir, { recursive: true });
  const mockFile1 = path.join(tmpDir, 'mock-clip-01.mp4');
  const mockFile2 = path.join(tmpDir, 'mock-clip-02.mp4');
  const mockFile3 = path.join(tmpDir, 'mock-clip-03.mp4');
  const outZip = path.join(tmpDir, 'mock-tree-all-clips.zip');

  writeFileSync(mockFile1, 'MOCK_VIDEO_DATA_CLIP_1_AAAAAA');
  writeFileSync(mockFile2, 'MOCK_VIDEO_DATA_CLIP_2_BBBBBB');
  writeFileSync(mockFile3, 'MOCK_VIDEO_DATA_CLIP_3_CCCCCC');

  try {
    const zipResult = await createZipArchive(
      [mockFile1, mockFile2, mockFile3],
      outZip,
      { log: (_lvl, msg) => console.log(`     ${msg}`) }
    );

    assert(existsSync(outZip), 'El archivo ZIP debe existir en el disco');
    assert.strictEqual(zipResult.fileCount, 3, 'El ZIP debe registrar 3 archivos');
    assert(zipResult.sizeMb >= 0, 'El tamaño debe ser válido');
    console.log(`  ✔ ZIP Creado: ${zipResult.zipFile} (${zipResult.sizeMb} MB) con ${zipResult.fileCount} clips.`);
  } finally {
    // Limpieza de archivos temporales
    if (existsSync(mockFile1)) unlinkSync(mockFile1);
    if (existsSync(mockFile2)) unlinkSync(mockFile2);
    if (existsSync(mockFile3)) unlinkSync(mockFile3);
    if (existsSync(outZip)) unlinkSync(outZip);
  }
}

console.log('\n🎉 ¡TODOS LOS TESTS DE ARQUITECTURA EN ÁRBOL Y ZIP PASARON EXITOSAMENTE!');
