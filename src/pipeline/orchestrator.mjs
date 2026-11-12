// Orquestador del pipeline de RuntimeClips.
//
// Ejecuta los 9 nodos en orden con los módulos reales (downloader, transcriber,
// hook_detector, reframe, overlays, captions, renderer). Cada etapa es una
// función `async (ctx, onProgress) => data`: `data` es lo que el dashboard
// muestra al inspeccionar el nodo y `ctx` lleva los resultados intermedios a
// las etapas siguientes.
//
// También es el CLI:  npm run clip -- <url|ruta> [--lang es] [--draft]
//                       [--start 12.5 --end 58] [--accent "#ffe600"] [--workers 1]

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

export const PIPELINE_NODES = [
  { key: 'input', label: 'Input', subtitle: 'YouTube URL / Local', icon: '🔗' },
  { key: 'ingest', label: 'Ingest & Probe', subtitle: 'yt-dlp + FFmpeg', icon: '⬇️' },
  { key: 'transcribe', label: 'Local Transcribe', subtitle: 'Parakeet / Whisper', icon: '🎙️' },
  { key: 'hook', label: 'Hook & Clip Selector', subtitle: 'Detección de 30-60 s', icon: '🎯' },
  { key: 'reframe', label: 'Full-Screen Reframe', subtitle: 'Centrado facial 9:16', icon: '🧑' },
  { key: 'overlays', label: 'Motion Overlays', subtitle: 'Capas GSAP transparentes', icon: '✨' },
  { key: 'captions', label: 'Karaoke Captions', subtitle: 'Alineación palabra/palabra', icon: '💬' },
  { key: 'render', label: 'Render & Audio QA', subtitle: 'FFmpeg a -14 LUFS', icon: '🎬' },
  { key: 'player', label: 'Final Player', subtitle: 'Previsualización y descarga', icon: '▶️' },
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

const STAGES = {
  // Valida el origen, comprueba las herramientas y crea la carpeta del proyecto.
  async input(ctx, onProgress) {
    const { job } = ctx;
    ctx.projectDir = path.join(ROOT, 'projects', job.runId);
    ctx.clipFile = prepareProject(ctx.projectDir);
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
    ctx.log('info', `Proyecto: ${rel(ctx.projectDir)} · telemetría de HyperFrames desactivada (${toolEnv().HYPERFRAMES_NO_TELEMETRY === '1' ? 'ok' : 'no'})`);
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
      original: {
        resolution: `${media.sourceProbe.width}x${media.sourceProbe.height}`,
        fps: media.sourceProbe.fps,
        variableFps: media.sourceProbe.variableFps,
        videoCodec: media.sourceProbe.videoCodec,
        audioCodec: media.sourceProbe.audioCodec,
      },
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
      fixedWords: transcript.fixedWords,
      transcript: rel(transcript.transcriptPath),
      sample: transcript.words.slice(0, 8),
      preview: transcript.words.slice(0, 40).map((w) => w.text).join(' '),
    };
  },

  async hook(ctx, onProgress) {
    const { words, sentences } = ctx.transcript;
    onProgress(0.2);
    ctx.hook = detectHook(
      { words, sentences, durationSec: ctx.media.durationSec, options: ctx.job.options },
      { log: ctx.log },
    );
    const { hook } = ctx;
    // Palabras del clip con tiempos relativos a su inicio: es lo que consumen overlays y subtítulos.
    ctx.clipWords = words
      .filter((w) => w.start >= hook.startSec - 0.05 && w.end <= hook.endSec + 0.05)
      .map((w) => ({
        text: w.text,
        start: Number(Math.max(0, w.start - hook.startSec).toFixed(3)),
        end: Number(Math.min(hook.durationSec, w.end - hook.startSec).toFixed(3)),
      }));
    if (!ctx.clipWords.length) ctx.log('warn', 'La ventana elegida no contiene palabras: el clip saldrá sin subtítulos');
    ctx.log('info', `Ventana elegida: ${fmtClock(hook.startSec)} → ${fmtClock(hook.endSec)} (${hook.durationSec.toFixed(1)} s)${hook.score === null ? '' : ` · score ${hook.score}`}`);
    for (const reason of hook.reasons) ctx.log('info', `· ${reason}`);
    writeFileSync(path.join(ctx.projectDir, 'hook.json'), `${JSON.stringify(hook, null, 2)}\n`);
    const { firstWord, lastWord, candidates, ...selected } = hook;
    return {
      window: [hook.startSec, hook.endSec],
      selected,
      text: ctx.clipWords.map((w) => w.text).join(' '),
      evaluated: hook.evaluated,
      alternatives: candidates.map(({ startSec, endSec, score, hook: opening, reasons }) => ({ startSec, endSec, score, hook: opening, reasons })),
    };
  },

  async reframe(ctx, onProgress) {
    ctx.frame = await reframe(
      { video: ctx.media.video, startSec: ctx.hook.startSec, endSec: ctx.hook.endSec, output: ctx.clipFile, options: ctx.job.options },
      { log: ctx.log, onProgress },
    );
    return { ...ctx.frame, output: rel(ctx.frame.output) };
  },

  async overlays(ctx, onProgress) {
    onProgress(0.2);
    return buildOverlays(
      { projectDir: ctx.projectDir, words: ctx.clipWords, durationSec: ctx.frame.durationSec, options: ctx.job.options },
      { log: ctx.log },
    );
  },

  async captions(ctx, onProgress) {
    onProgress(0.2);
    return buildCaptions(
      { projectDir: ctx.projectDir, words: ctx.clipWords, durationSec: ctx.frame.durationSec },
      { log: ctx.log },
    );
  },

  async render(ctx, onProgress) {
    const { job } = ctx;
    const name = [slugify(ctx.media.meta.title) || 'clip', job.runId].join('-');
    mkdirSync(job.rendersDir, { recursive: true });
    ctx.render = await renderClip(
      { projectDir: ctx.projectDir, outFile: path.join(job.rendersDir, `${name}.mp4`), durationSec: ctx.frame.durationSec, options: job.options },
      { log: ctx.log, onProgress },
    );
    ctx.output = { videoUrl: `/renders/${encodeURIComponent(ctx.render.file)}`, fileName: ctx.render.file };
    const { path: _absolute, ...data } = ctx.render;
    return data;
  },

  async player(ctx, onProgress) {
    onProgress(0.5);
    ctx.log('info', `Reel listo: renders/${ctx.render.file} (${ctx.render.sizeMb} MB, ${ctx.render.durationSec.toFixed(1)} s)`);
    return {
      ...ctx.output,
      title: ctx.media.meta.title ?? null,
      hook: ctx.hook.hook,
      sourceWindow: `${fmtClock(ctx.hook.startSec)} → ${fmtClock(ctx.hook.endSec)}`,
      durationSec: ctx.render.durationSec,
      sizeMb: ctx.render.sizeMb,
      qa: ctx.render.qa.pass ? 'LISTO' : 'REVISAR',
    };
  },
};

// Ejecuta los 9 nodos en orden. `emit.node(key, patch)` y `emit.log(level, msg, key)`
// son provistos por el servidor y se retransmiten por SSE.
export async function runPipeline(job, emit) {
  const ctx = { job, emit, output: null };
  for (const node of PIPELINE_NODES) {
    const startedAt = Date.now();
    emit.node(node.key, { status: 'running', progress: 0, startedAt });
    emit.log('info', `▶ ${node.label} iniciado`, node.key);
    ctx.log = (level, message) => emit.log(level, message, node.key);
    // El progreso se emite como mucho cada 100 ms y nunca retrocede.
    let lastProgress = 0;
    let lastEmit = 0;
    const onProgress = (value) => {
      const progress = Math.min(0.99, Math.max(lastProgress, Number(value) || 0));
      if (progress === lastProgress || Date.now() - lastEmit < 100) return;
      lastProgress = progress;
      lastEmit = Date.now();
      emit.node(node.key, { progress });
    };
    try {
      const data = await STAGES[node.key](ctx, onProgress);
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
  return ctx.output;
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
    console.error('Uso: npm run clip -- <URL de YouTube | ruta local> [--lang es] [--draft] [--start S --end S] [--accent "#ffe600"] [--workers 1]');
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
    log: (level, message, node) => console.log(`${stamp()} ${level.padEnd(7)} ${(node ?? 'pipeline').padEnd(10)} ${message}`),
    pipeline() {},
  };
  try {
    const output = await runPipeline(job, emit);
    console.log(`\nReel: renders/${output.fileName}`);
  } catch (err) {
    console.error(`\nPipeline detenido: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
