// Nodo 8 — Render & Audio QA.
//
// 1. Compila el proyecto HyperFrames: index.html desde src/template con el
//    video a lienzo completo, los overlays GSAP y los subtítulos karaoke.
// 2. Renderiza con el CLI fijado (Chrome headless, fotograma a fotograma).
// 3. Normaliza la sonoridad a -14 LUFS (mide con loudnorm, aplica ganancia fija
//    y limitador si hace falta, y vuelve a medir: true peak <= -1 dBTP). El
//    video se copia intacto; el audio queda en AAC 48 kHz.
// 4. Mide el archivo final y lo compara contra las reglas del proyecto.

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CANVAS, FPS, ROOT, exec, ffmpeg, hf, probeMedia, requireTool } from './tools.mjs';
import { CAPTIONS_ZONE } from './captions.mjs';

const TEMPLATE_DIR = path.join(ROOT, 'src', 'template');
const TARGET_LUFS = -14;
// -1,5 dBTP en lugar de -1: la codificación AAC añade unas décimas de sobrepico.
const PEAK_CEILING = -1.5;
const LOUDNORM = `I=${TARGET_LUFS}:TP=${PEAK_CEILING}:LRA=11`;

/** Crea la estructura del proyecto y copia los assets fijos (GSAP y fuentes). */
export function prepareProject(projectDir) {
  for (const sub of ['assets', 'compositions']) mkdirSync(path.join(projectDir, sub), { recursive: true });
  cpSync(path.join(TEMPLATE_DIR, 'assets'), path.join(projectDir, 'assets'), { recursive: true });
  writeFileSync(path.join(projectDir, 'meta.json'), `${JSON.stringify({ id: path.basename(projectDir), name: path.basename(projectDir) }, null, 2)}\n`);
  writeFileSync(path.join(projectDir, 'hyperframes.json'), `${JSON.stringify({
    paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' },
  }, null, 2)}\n`);
  return path.join(projectDir, 'assets', 'clip.mp4');
}

const overlaySlot = (o) => `
      <div
        id="el-${o.id}"
        class="layer"
        data-composition-id="${o.id}"
        data-composition-src="compositions/${o.id}.html"
        data-start="${o.start}"
        data-duration="${Number((o.end - o.start).toFixed(4))}"
        data-track-index="${o.track}"
        data-width="${CANVAS.w}"
        data-height="${CANVAS.h}"
      ></div>`;

/** Escribe index.html: video al 100 % del lienzo + slots de overlays + subtítulos. */
export function compileComposition({ projectDir, durationSec, accent = '#ffe600' }) {
  const overlays = JSON.parse(readFileSync(path.join(projectDir, 'overlays.json'), 'utf8'));
  // Solo fotogramas completos: una duración que pase del último deja una cola negra.
  const duration = Number((Math.floor(durationSec * FPS) / FPS).toFixed(4));
  const fit = (o) => ({ ...o, end: Math.min(o.end, duration) });
  const start = '<!-- OVERLAYS:START (generado por renderer.mjs desde overlays.json) -->';
  const end = '<!-- OVERLAYS:END -->';
  let html = readFileSync(path.join(TEMPLATE_DIR, 'index.html'), 'utf8');
  html = html.slice(0, html.indexOf(start) + start.length) + overlays.map((o) => overlaySlot(fit(o))).join('') + '\n      ' + html.slice(html.indexOf(end));
  html = html
    .replaceAll('{{DURATION}}', String(duration))
    .replaceAll('{{ACCENT}}', /^#[0-9a-f]{3,8}$/i.test(accent) ? accent : '#ffe600')
    .replaceAll('{{CAPTIONS_TOP}}', String(CAPTIONS_ZONE.top))
    .replaceAll('{{CAPTIONS_HEIGHT}}', String(CAPTIONS_ZONE.height))
    .replaceAll('{{CAPTIONS_TRACK}}', '4');
  writeFileSync(path.join(projectDir, 'index.html'), html);
  return { duration, frames: Math.round(duration * FPS), overlays: overlays.length };
}

async function measureLoudness(file) {
  const { stderr } = await exec(requireTool('ffmpeg'), [
    '-hide_banner', '-nostats', '-i', file, '-vn', '-af', `loudnorm=${LOUDNORM}:print_format=json`, '-f', 'null', '-',
  ]);
  return JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1));
}

/**
 * @param {{ projectDir: string, outFile: string, durationSec: number, options?: object }} input
 * @returns datos técnicos del MP4 final y el resultado del QA
 */
export async function renderClip({ projectDir, outFile, durationSec, options = {} }, { log, onProgress }) {
  const composition = compileComposition({ projectDir, durationSec, accent: options.accent });
  log('info', `Composición: ${composition.frames} fotogramas (${composition.duration} s) · ${composition.overlays} overlays + subtítulos`);

  // 1. Render de la composición (0 → 85 % de la barra).
  const master = outFile.replace(/\.mp4$/, '.master.mp4');
  const quality = options.draft ? 'draft' : 'delivery';
  // Cada worker es un Chrome (~256 MB): con poca RAM libre, 1 worker evita caídas.
  const workers = options.workers ? ['--workers', String(options.workers)] : [];
  log('info', `HyperFrames ${quality}: capturando ${composition.frames} fotogramas con Chrome headless`);
  const PHASES = { capture: 'captura', encode: 'codificación' };
  let lastLogged = '';
  const onLine = (line) => {
    const text = line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim();
    // El CLI informa su avance como "@hf-progress {json}" (captura → codificación).
    const marker = text.indexOf('@hf-progress ');
    if (marker >= 0) {
      let event;
      try {
        event = JSON.parse(text.slice(marker + 13));
      } catch {
        return;
      }
      if (!Number.isFinite(event.pct)) return;
      onProgress((event.pct / 100) * 0.85);
      const step = `${event.code}:${Math.floor((event.done / event.total) * 10)}`;
      if (step !== lastLogged && event.total && PHASES[event.code]) {
        lastLogged = step;
        log('info', `Render ${event.pct} % · ${PHASES[event.code] ?? event.code} ${event.done}/${event.total} fotogramas`);
      }
    } else if (/\[(WARN|ERROR)\]|Audio lowered|capture ·/.test(text) && !text.includes("[Render:trace]")) {
      log(/\[(WARN|ERROR)\]/.test(text) ? "warn" : "info", `HyperFrames: ${text.slice(0, 200)}`);
    }
  };
  rmSync(master, { force: true });
  await hf(['render', projectDir, '-o', master, '--fps', String(FPS), '--quality', quality, '--strict', ...workers], {
    cwd: projectDir,
    onStdout: onLine,
    onStderr: onLine,
  });
  if (!existsSync(master)) throw new Error('HyperFrames terminó sin escribir el video.');
  onProgress(0.85);

  // 2. Sonoridad: medir, ajustar y volver a medir (85 → 97 %).
  log('info', `Midiendo sonoridad (objetivo ${TARGET_LUFS} LUFS, true peak ≤ -1 dBTP)`);
  const measured = await measureLoudness(master);
  let final = null;
  if (!Number.isFinite(Number(measured.input_i))) {
    log('warn', 'El render no tiene audio medible (silencio): se entrega sin normalizar');
    renameSync(master, outFile);
  } else {
    // Ganancia fija hasta el objetivo. Si con ella el pico pasaría de -1,5 dBTP
    // se añade un limitador; loudnorm en modo dinámico no sirve aquí porque en
    // clips cortos deja sobrepicos por encima de 0 dBTP.
    const gain = TARGET_LUFS - Number(measured.input_i);
    const needsLimiter = Number(measured.input_tp) + gain > PEAK_CEILING;
    log('info', `Medido: ${measured.input_i} LUFS · pico ${measured.input_tp} dBTP → ganancia ${gain >= 0 ? '+' : ''}${gain.toFixed(2)} dB${needsLimiter ? ' + limitador' : ''}`);
    // El limitador trabaja sobre picos de muestra: 1 dB extra de margen cubre los picos entre muestras.
    const limiter = `alimiter=limit=${(10 ** ((PEAK_CEILING - 1) / 20)).toFixed(4)}:level=false:attack=5:release=80`;
    const encode = (trim) => ffmpeg([
      '-i', master,
      '-af', [`volume=${(gain - trim).toFixed(2)}dB`, ...(needsLimiter ? [limiter] : [])].join(','),
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart',
      outFile,
    ], { totalSec: composition.duration, onProgress: (p) => onProgress(0.85 + p * 0.12) });
    await encode(0);
    final = await measureLoudness(outFile);
    // AAC puede añadir unas décimas de sobrepico: si aun así pasa de -1 dBTP, se baja lo justo.
    if (Number(final.input_tp) > -1) {
      const trim = Number(final.input_tp) - PEAK_CEILING;
      log('warn', `True peak ${final.input_tp} dBTP tras codificar: se recorta ${trim.toFixed(2)} dB`);
      await encode(trim);
      final = await measureLoudness(outFile);
    }
    if (!options.keepMaster) rmSync(master, { force: true });
  }
  onProgress(0.97);

  // 3. QA técnico del archivo final.
  const probe = await probeMedia(outFile);
  const lufs = final ? Number(final.input_i) : null;
  const truePeak = final ? Number(final.input_tp) : null;
  const checks = {
    resolution: probe.width === CANVAS.w && probe.height === CANVAS.h,
    fps: Math.abs(probe.fps - FPS) < 0.01 && !probe.variableFps,
    videoCodec: probe.videoCodec === 'h264' && probe.pixFmt === 'yuv420p',
    audioCodec: probe.audioCodec === 'aac' && probe.sampleRate === 48000,
    loudness: lufs !== null && Math.abs(lufs - TARGET_LUFS) <= 1,
    truePeak: truePeak !== null && truePeak <= -1,
    duration: Math.abs(probe.durationSec - composition.duration) <= 0.1,
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  log('info', `Video: ${probe.videoCodec} ${probe.pixFmt} ${probe.width}x${probe.height} @ ${probe.fps} fps · Audio: ${probe.audioCodec} ${probe.sampleRate} Hz ${probe.channels} ch`);
  log(checks.loudness && checks.truePeak ? 'info' : 'warn', `Sonoridad final: ${lufs ?? '—'} LUFS · true peak ${truePeak ?? '—'} dBTP`);
  if (failed.length) log('warn', `QA: fuera de especificación → ${failed.join(', ')}`);
  else log('success', 'QA: el archivo cumple todas las reglas técnicas');
  // Formato equivocado no es publicable: se detiene el pipeline. La sonoridad solo se avisa.
  const fatal = failed.filter((name) => ['resolution', 'fps', 'videoCodec', 'audioCodec'].includes(name));
  if (fatal.length) throw new Error(`El render no cumple el formato obligatorio (${fatal.join(', ')}).`);

  return {
    file: path.basename(outFile),
    path: outFile,
    sizeMb: Number((probe.sizeBytes / 1e6).toFixed(2)),
    durationSec: probe.durationSec,
    frames: composition.frames,
    resolution: `${probe.width}x${probe.height}`,
    fps: probe.fps,
    videoCodec: `${probe.videoCodec} (${probe.pixFmt})`,
    audioCodec: `${probe.audioCodec} ${probe.sampleRate / 1000} kHz`,
    quality,
    loudness: {
      targetLufs: TARGET_LUFS,
      sourceLufs: Number(measured.input_i),
      finalLufs: lufs,
      truePeakDbtp: truePeak,
      truePeakMaxDbtp: -1,
    },
    qa: { pass: failed.length === 0, checks },
  };
}
