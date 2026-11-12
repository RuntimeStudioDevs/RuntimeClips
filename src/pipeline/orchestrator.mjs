// Orquestador del pipeline en árbol (Fork/Join) de RuntimeClips.
//
// Estructura en tres fases:
// 1. Tronco Común: Ingesta, sondeo, transcripción local y detección de todos los clips virales.
// 2. Bifurcación (Fan-Out): Ejecución concurrente por ramas independientes (reframe -> overlays -> captions -> render).
// 3. Convergencia (Fan-In): Empaquetado maestro en .zip (Collector) y reproductor multi-clip (Player).

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, HF_VERSION, findTool, fmtClock, requireTool, toolEnv, exec } from './tools.mjs';
import { ingest } from './downloader.mjs';
import { transcribe } from './transcriber.mjs';
import { detectHook } from './hook_detector.mjs';
import { reframe } from './reframe.mjs';
import { buildOverlays } from './overlays.mjs';
import { buildCaptions } from './captions.mjs';
import { prepareProject, renderClip } from './renderer.mjs';
import { createZipArchive } from './packager.mjs';

export const TRUNK_NODES = [
  { key: 'input', label: 'Input', subtitle: 'YouTube URL / Local', icon: '🔗' },
  { key: 'ingest', label: 'Ingest & Probe', subtitle: 'yt-dlp + FFmpeg', icon: '⬇️' },
  { key: 'transcribe', label: 'Local Transcribe', subtitle: 'Parakeet / Whisper', icon: '🎙️' },
  { key: 'hook', label: 'Hook & Clip Selector', subtitle: 'Detección Multi-Clip', icon: '🎯' },
];

export const JOIN_NODES = [
  { key: 'collector', label: 'ZIP Packager', subtitle: 'Empaquetado .zip', icon: '📦' },
  { key: 'player', label: 'Multi-Clip Player', subtitle: 'Galería y Descarga', icon: '▶️' },
];

export const PIPELINE_NODES = [
  ...TRUNK_NODES,
  { key: 'reframe', label: 'Full-Screen Reframe', subtitle: 'Centrado facial 9:16', icon: '🧑' },
  { key: 'overlays', label: 'Motion Overlays', subtitle: 'Capas GSAP transparentes', icon: '✨' },
  { key: 'captions', label: 'Karaoke Captions', subtitle: 'Alineación palabra/palabra', icon: '💬' },
  { key: 'render', label: 'Render & Audio QA', subtitle: 'FFmpeg a -14 LUFS', icon: '🎬' },
  ...JOIN_NODES,
];

const rel = (file) => path.relative(ROOT, file).replaceAll('\\', '/');

const slugify = (text) =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

async function toolVersion(name, args, pattern) {
  const { stdout, stderr } = await exec(requireTool(name), args, { allowFail: true });
  return pattern.exec(`${stdout}\n${stderr}`)?.[1] ?? 'desconocida';
}

/**
 * Ejecutor en cola de concurrencia acotada (Worker Pool)
 */
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

// ── FASE 1: Tronco Común ─────────────────────────────────────────────────────

const TRUNK_STAGES = {
  async input(ctx, onProgress) {
    const { job } = ctx;
    ctx.projectDir = path.join(ROOT, 'projects', job.runId);
    mkdirSync(ctx.projectDir, { recursive: true });
    ctx.log('info', `Origen (${job.sourceType}): ${job.url}`);
    onProgress(0.3);

    const tools = {
      ffmpeg: await toolVersion('ffmpeg', ['-version'], /ffmpeg version (\S+)/),
      ffprobe: findTool('ffprobe') ? 'ok' : null,
      ...(job.sourceType === 'local' ? {} : { 'yt-dlp': await toolVersion('yt-dlp', ['--version'], /(\d{4}\.\d+\.\d+\S*)/) }),
      hyperframes: HF_VERSION,
      node: process.version,
    };
    requireTool('ffprobe');
    ctx.log('info', `Herramientas: ${Object.entries(tools).map(([name, version]) => `${name} ${version}`).join(' · ')}`);
    return { source: job.url, sourceType: job.sourceType, options: job.options, projectDir: rel(ctx.projectDir), tools };
  },

  async ingest(ctx, onProgress) {
    const { job } = ctx;
    ctx.media = await ingest(
      { url: job.url, sourceType: job.sourceType, projectDir: ctx.projectDir, options: job.options },
      { log: ctx.log, onProgress },
    );
    const { media } = ctx;
    return {
      title: media.meta.title ?? null,
      uploader: media.meta.uploader ?? null,
      video: rel(media.video),
      audio: `${rel(media.audio)} (mono 16 kHz)`,
      normalized: media.normalized,
      durationSec: media.durationSec,
      width: media.width,
      height: media.height,
      fps: media.fps,
      videoCodec: `${media.videoCodec} (${media.pixFmt})`,
      audioCodec: media.audioCodec,
      sampleRate: media.sampleRate,
    };
  },

  async transcribe(ctx, onProgress) {
    ctx.transcript = await transcribe(
      { audio: ctx.media.audio, projectDir: ctx.projectDir, durationSec: ctx.media.durationSec, options: ctx.job.options },
      { log: ctx.log, onProgress },
    );
    const { transcript } = ctx;
    return {
      engine: transcript.engine,
      model: transcript.model,
      language: transcript.language,
      sentences: transcript.sentences.length,
      words: transcript.words.length,
      transcript: rel(transcript.transcriptPath),
      preview: transcript.words.slice(0, 30).map((w) => w.text).join(' '),
    };
  },

  async hook(ctx, onProgress) {
    const { words, sentences } = ctx.transcript;
    onProgress(0.2);
    ctx.hook = detectHook(
      { words, sentences, durationSec: ctx.media.durationSec, options: ctx.job.options || {} },
      { log: ctx.log },
    );
    const { hook } = ctx;
    writeFileSync(path.join(ctx.projectDir, 'hook.json'), `${JSON.stringify(hook, null, 2)}\n`);

    const { firstWord, lastWord, candidates, clips, ...selected } = hook;
    return {
      selected,
      clips: clips || [selected],
      totalClips: (clips || [selected]).length,
      evaluated: hook.evaluated,
      theoreticalMax: hook.theoreticalMax,
    };
  },
};

// ── FASE 2: Ramas Paralelas por Clip ─────────────────────────────────────────

async function runClipBranch(ctx, clip, clipIdx, emit) {
  const cid = clip.clipId;
  const k = clipIdx + 1;
  const clipDir = path.join(ctx.projectDir, cid);
  mkdirSync(clipDir, { recursive: true });
  const clipFile = prepareProject(clipDir);

  const words = ctx.transcript.words;
  const clipWords = words
    .filter((w) => w.start >= clip.startSec - 0.05 && w.end <= clip.endSec + 0.05)
    .map((w) => ({
      text: w.text,
      start: Number(Math.max(0, w.start - clip.startSec).toFixed(3)),
      end: Number(Math.min(clip.durationSec, w.end - clip.startSec).toFixed(3)),
    }));

  async function execNode(nodeKey, label, fn) {
    const startedAt = Date.now();
    emit.node(nodeKey, { status: 'running', progress: 0, startedAt });
    emit.log('info', `▶ [Clip #${k}] ${label} iniciado`, nodeKey);
    let lastProgress = 0;
    const onProgress = (val) => {
      const p = Math.min(0.99, Math.max(lastProgress, Number(val) || 0));
      if (p !== lastProgress) {
        lastProgress = p;
        emit.node(nodeKey, { progress: p });
      }
    };
    try {
      const data = await fn(onProgress);
      const finishedAt = Date.now();
      emit.node(nodeKey, { status: 'completed', progress: 1, finishedAt, durationMs: finishedAt - startedAt, data });
      emit.log('success', `✔ [Clip #${k}] ${label} completado en ${finishedAt - startedAt} ms`, nodeKey);
      return data;
    } catch (err) {
      const finishedAt = Date.now();
      emit.node(nodeKey, { status: 'error', finishedAt, durationMs: finishedAt - startedAt, error: err.message });
      emit.log('error', `✖ [Clip #${k}] ${label}: ${err.message}`, nodeKey);
      throw err;
    }
  }

  // 1. Reframe
  const frame = await execNode(`reframe-${cid}`, 'Reframe 9:16', (onProgress) =>
    reframe(
      { video: ctx.media.video, startSec: clip.startSec, endSec: clip.endSec, output: clipFile, options: ctx.job.options },
      { log: (lvl, msg) => emit.log(lvl, msg, `reframe-${cid}`), onProgress },
    )
  );

  // 2. Overlays
  await execNode(`overlays-${cid}`, 'Motion Overlays', (onProgress) => {
    onProgress(0.2);
    return buildOverlays(
      { projectDir: clipDir, words: clipWords, durationSec: frame.durationSec, options: ctx.job.options },
      { log: (lvl, msg) => emit.log(lvl, msg, `overlays-${cid}`) },
    );
  });

  // 3. Captions
  await execNode(`captions-${cid}`, 'Karaoke Captions', (onProgress) => {
    onProgress(0.2);
    return buildCaptions(
      { projectDir: clipDir, words: clipWords, durationSec: frame.durationSec },
      { log: (lvl, msg) => emit.log(lvl, msg, `captions-${cid}`) },
    );
  });

  // 4. Render & QA
  const clipSlug = slugify(clip.title || clip.hook || `clip-${k}`);
  const outFileName = `${clipSlug}-${ctx.job.runId}-${cid}.mp4`;
  const outFilePath = path.join(ctx.job.rendersDir, outFileName);

  const renderResult = await execNode(`render-${cid}`, 'Render & Audio QA', (onProgress) =>
    renderClip(
      { projectDir: clipDir, outFile: outFilePath, durationSec: frame.durationSec, options: ctx.job.options },
      { log: (lvl, msg) => emit.log(lvl, msg, `render-${cid}`), onProgress },
    )
  );

  return {
    clipId: cid,
    rank: k,
    title: clip.title,
    hook: clip.hook,
    score: clip.score,
    scorePercent: clip.scorePercent,
    startSec: clip.startSec,
    endSec: clip.endSec,
    durationSec: renderResult.durationSec,
    file: outFileName,
    filePath: outFilePath,
    videoUrl: `/renders/${encodeURIComponent(outFileName)}`,
    sizeMb: renderResult.sizeMb,
    qa: renderResult.qa,
  };
}

// ── FASE 3: Convergencia (Collector & ZIP) ───────────────────────────────────

async function runCollector(ctx, renderedClips, emit) {
  const nodeKey = 'collector';
  const startedAt = Date.now();
  emit.node(nodeKey, { status: 'running', progress: 0, startedAt });
  emit.log('info', `Iniciando empaquetado de ${renderedClips.length} clips en .zip…`, nodeKey);

  const zipName = [slugify(ctx.media.meta.title) || 'runtimeclips', ctx.job.runId, 'all-clips.zip'].join('-');
  const zipPath = path.join(ctx.job.rendersDir, zipName);

  const zipResult = await createZipArchive(
    renderedClips.map((c) => c.filePath),
    zipPath,
    { log: (lvl, msg) => emit.log(lvl, msg, nodeKey) }
  );

  const finishedAt = Date.now();
  const data = {
    zipFile: zipResult.zipFile,
    zipUrl: `/renders/${encodeURIComponent(zipResult.zipFile)}`,
    zipSizeMb: zipResult.sizeMb,
    totalClips: renderedClips.length,
    clips: renderedClips,
  };
  emit.node(nodeKey, { status: 'completed', progress: 1, finishedAt, durationMs: finishedAt - startedAt, data });
  emit.log('success', `✔ Paquete ZIP creado: ${zipResult.zipFile} (${zipResult.sizeMb} MB) con ${renderedClips.length} clips`, nodeKey);
  return data;
}

// ── FASE 4: Reproductor Final Multi-Clip ──────────────────────────────────────

async function runPlayer(ctx, renderedClips, collectorData, emit) {
  const nodeKey = 'player';
  const startedAt = Date.now();
  emit.node(nodeKey, { status: 'running', progress: 0.5, startedAt });

  const bestClip = renderedClips[0] || null;
  ctx.output = {
    title: ctx.media.meta.title ?? 'Reels',
    zipUrl: collectorData.zipUrl,
    zipFile: collectorData.zipFile,
    zipSizeMb: collectorData.zipSizeMb,
    totalClips: renderedClips.length,
    videoUrl: bestClip ? bestClip.videoUrl : null,
    fileName: bestClip ? bestClip.file : null,
    clips: renderedClips,
  };

  const finishedAt = Date.now();
  emit.node(nodeKey, { status: 'completed', progress: 1, finishedAt, durationMs: finishedAt - startedAt, data: ctx.output });
  emit.log('success', `✔ Proceso completado: ${renderedClips.length} clips listos con descarga individual y paquete .ZIP`, nodeKey);
  return ctx.output;
}

// ── Ejecutor Principal del Árbol (runPipeline) ───────────────────────────────

export async function runPipeline(job, emit) {
  const ctx = { job, emit, output: null };

  // 1. Tronco común
  for (const node of TRUNK_NODES) {
    const startedAt = Date.now();
    emit.node(node.key, { status: 'running', progress: 0, startedAt });
    emit.log('info', `▶ ${node.label} iniciado`, node.key);
    ctx.log = (level, message) => emit.log(level, message, node.key);

    let lastProgress = 0;
    const onProgress = (value) => {
      const progress = Math.min(0.99, Math.max(lastProgress, Number(value) || 0));
      if (progress !== lastProgress) {
        lastProgress = progress;
        emit.node(node.key, { progress });
      }
    };

    try {
      const data = await TRUNK_STAGES[node.key](ctx, onProgress);
      const finishedAt = Date.now();
      emit.node(node.key, { status: 'completed', progress: 1, finishedAt, durationMs: finishedAt - startedAt, data });
      emit.log('success', `✔ ${node.label} completado en ${finishedAt - startedAt} ms`, node.key);
    } catch (err) {
      const finishedAt = Date.now();
      emit.node(node.key, { status: 'error', finishedAt, durationMs: finishedAt - startedAt, error: err.message });
      emit.log('error', `✖ ${node.label}: ${err.message}`, node.key);
      throw err;
    }
  }

  // 2. Selección de clips objetivo para las ramas
  let targetClips = ctx.hook.clips || [];
  if (job.options.clipLimit && job.options.clipLimit !== 'all') {
    const limit = Number(job.options.clipLimit);
    if (limit > 0) targetClips = targetClips.slice(0, limit);
  } else if (Number(job.options.maxClips) > 0) {
    targetClips = targetClips.slice(0, Number(job.options.maxClips));
  }
  if (!targetClips.length && ctx.hook.startSec != null) {
    targetClips = [{ ...ctx.hook, clipId: 'clip-01', rank: 1 }];
  }

  // 3. Expansión del grafo en árbol en el servidor y SSE
  const branchNodes = [];
  const edges = [
    { from: 'input', to: 'ingest' },
    { from: 'ingest', to: 'transcribe' },
    { from: 'transcribe', to: 'hook' },
  ];

  targetClips.forEach((clip, idx) => {
    const k = idx + 1;
    const cid = clip.clipId;
    const shortTitle = (clip.title || clip.hook || `Clip ${k}`).slice(0, 22);

    branchNodes.push(
      { key: `reframe-${cid}`, label: `Reframe #${k}`, subtitle: `Facial · ${shortTitle}`, icon: '🧑', branchId: cid, clipIndex: idx },
      { key: `overlays-${cid}`, label: `Overlays #${k}`, subtitle: 'Motion GSAP', icon: '✨', branchId: cid, clipIndex: idx },
      { key: `captions-${cid}`, label: `Captions #${k}`, subtitle: 'Karaoke sync', icon: '💬', branchId: cid, clipIndex: idx },
      { key: `render-${cid}`, label: `Render #${k}`, subtitle: 'FFmpeg -14 LUFS', icon: '🎬', branchId: cid, clipIndex: idx },
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

  if (typeof emit.expandGraph === 'function') {
    emit.expandGraph({
      trunkNodes: TRUNK_NODES,
      branchNodes,
      joinNodes: JOIN_NODES,
      edges,
      totalBranches: targetClips.length,
    });
  }

  // 4. Ejecución concurrente por ramas con Worker Pool
  const concurrency = Math.max(1, Math.min(6, Number(job.options.workers) || 2));
  emit.log('info', `Abriendo ${targetClips.length} ramas en paralelo (concurrencia: ${concurrency} workers)…`, 'hook');

  const renderedClips = [];
  await runWorkerPool(targetClips, concurrency, async (clip, clipIdx) => {
    try {
      const result = await runClipBranch(ctx, clip, clipIdx, emit);
      if (result) renderedClips.push(result);
    } catch (err) {
      emit.log('error', `Error en rama Clip #${clipIdx + 1}: ${err.message}`, `render-${clip.clipId}`);
    }
  });

  if (!renderedClips.length) {
    throw new Error('Ninguna rama de clip pudo renderizarse con éxito.');
  }

  // 5. Convergencia en Collector (Empaquetado ZIP)
  const collectorData = await runCollector(ctx, renderedClips, emit);

  // 6. Convergencia en Player (Multi-clip reproductor)
  return runPlayer(ctx, renderedClips, collectorData, emit);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const { existsSync } = await import('node:fs');
  const args = process.argv.slice(2);
  const options = {};
  let source = null;
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) {
      source ??= args[i];
      continue;
    }
    const key = args[i].slice(2);
    const next = args[i + 1];
    options[key] = next !== undefined && !next.startsWith('--') ? args[++i] : true;
  }
  if (!source) {
    console.error('Uso: npm run clip -- <URL de YouTube | ruta local> [--workers 2] [--clipLimit 5]');
    process.exit(1);
  }
  const isUrl = /^https?:\/\//i.test(source);
  if (!isUrl && !existsSync(source)) {
    console.error(`No existe el archivo: ${source}`);
    process.exit(1);
  }
  const job = {
    runId: Date.now().toString(36),
    url: source,
    sourceType: isUrl ? (/(youtube\.com|youtu\.be)/i.test(source) ? 'youtube' : 'url') : 'local',
    options,
    rendersDir: path.join(ROOT, 'renders'),
  };
  const stamp = () => new Date().toISOString().slice(11, 19);
  const emit = {
    node() {},
    expandGraph() {},
    log: (level, message, node) => console.log(`${stamp()} ${level.padEnd(7)} ${(node ?? 'pipeline').padEnd(14)} ${message}`),
    pipeline() {},
  };
  try {
    const output = await runPipeline(job, emit);
    console.log(`\n🎉 Completado: ${output.totalClips} clips empaquetados en ${output.zipFile}`);
  } catch (err) {
    console.error(`\nPipeline detenido: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
