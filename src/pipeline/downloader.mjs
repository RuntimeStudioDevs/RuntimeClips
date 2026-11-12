// Nodo 2 — Ingest & Probe.
//
// Descarga el video con yt-dlp (o valida la ruta local), lo analiza con
// ffprobe, lo normaliza a 30 fps constantes (H.264 yuv420p + AAC 48 kHz) y
// extrae el audio mono a 16 kHz que consume el transcriptor.

import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { FPS, exec, ffmpeg, findTool, probeMedia, requireTool } from './tools.mjs';

// Recodificar una hora de video para usar 45 s es tiempo perdido: por encima de
// este umbral el video completo se deja tal cual y la normalización a 30 fps se
// aplica solo a la ventana elegida (la hace reframe.mjs en una única pasada).
const NORMALIZE_MAX_SEC = 600;

const VIDEO_EXT = /\.(mp4|mkv|webm|mov|m4v|avi)$/i;

async function downloadWithYtDlp(url, dir, { maxHeight, log, onProgress }) {
  const ytdlp = requireTool('yt-dlp');
  // YouTube exige un runtime de JS para resolver las firmas: yt-dlp usa Deno si está en el PATH (lo agrega toolEnv).
  if (!findTool('deno')) log('warn', 'Deno no está instalado: yt-dlp puede no ver todos los formatos de YouTube');
  log('info', `yt-dlp: resolviendo formatos (≤ ${maxHeight}p)`);

  // Video y audio llegan como dos descargas ("Destination" marca el inicio de
  // cada una) y, si el formato es HLS, en fragmentos cuya estimación de tamaño
  // oscila: el avance de cada parte solo sube.
  let part = -1;
  let best = 0;
  let lastLogged = -1;
  await exec(ytdlp, [
    url,
    '--no-playlist', '--no-warnings', '--newline', '--no-colors',
    '-f', `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b`,
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', path.dirname(requireTool('ffmpeg')),
    '--write-info-json',
    '--progress-template', 'download:PROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '-o', path.join(dir, 'source.%(ext)s'),
  ], {
    onStdout: (line) => {
      if (line.startsWith('[download] Destination:')) {
        part = Math.min(part + 1, 1);
        best = 0;
        lastLogged = -1;
      } else if (line.startsWith('PROGRESS|')) {
        const [, done, total, estimate, speed, eta] = line.split('|');
        const size = Number(total) || Number(estimate);
        if (!size) return;
        best = Math.max(best, Math.min(1, Number(done) / size));
        onProgress((Math.max(part, 0) + best) / 2);
        const decile = Math.floor(best * 10);
        if (decile > lastLogged) {
          lastLogged = decile;
          log('info', `yt-dlp: ${part <= 0 ? 'video' : 'audio'} ${Math.round(best * 100)} % · ${speed.trim()} · ETA ${eta.trim()}`);
        }
      } else if (/^\[Merger\]|Downloading \d+ format/.test(line)) {
        log('info', `yt-dlp: ${line.replace(/^\[[\w:]+\]\s*/, '').replace(/^\S+: (?=Downloading)/, '').slice(0, 160)}`);
      }
    },
  });

  const file = readdirSync(dir).find((name) => name.startsWith('source.') && VIDEO_EXT.test(name));
  if (!file) throw new Error('yt-dlp terminó sin dejar un archivo de video.');
  let meta = {};
  try {
    const info = JSON.parse(readFileSync(path.join(dir, 'source.info.json'), 'utf8'));
    meta = { id: info.id, title: info.title, uploader: info.uploader ?? info.channel ?? null, webpageUrl: info.webpage_url };
  } catch {
    // Sin metadatos: el clip se genera igual.
  }
  return { file: path.join(dir, file), meta };
}

/**
 * Normaliza a 30 fps constantes, H.264 yuv420p y AAC 48 kHz, con un fotograma
 * clave por segundo (el render busca fotograma a fotograma). El lado corto se
 * limita a 1080 px: más píxeles solo hacen más lento el resto del pipeline.
 */
export async function normalizeVideo(input, output, probe, { onProgress } = {}) {
  const scale = probe.height >= probe.width ? "scale='min(1080,iw)':-2" : "scale=-2:'min(1080,ih)'";
  await ffmpeg([
    '-i', input,
    '-vf', `${scale},fps=${FPS}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-g', String(FPS), '-keyint_min', String(FPS), '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p',
    ...(probe.hasAudio ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'] : ['-an']),
    '-movflags', '+faststart',
    output,
  ], { totalSec: probe.durationSec, onProgress });
}

/**
 * @param {{ url: string, sourceType: 'youtube'|'url'|'local', projectDir: string, options?: object }} job
 * @param {{ log: (level: string, message: string) => void, onProgress: (p: number) => void }} hooks
 */
export async function ingest({ url, sourceType, projectDir, options = {} }, { log, onProgress }) {
  const maxHeight = Number(options.maxHeight) || 1080;
  const normalizeMaxSec = Number(options.normalizeMaxSec) || NORMALIZE_MAX_SEC;

  // 1. Origen: descarga o archivo local (0 → 45 % de la barra).
  let original;
  let meta = {};
  if (sourceType === 'local') {
    original = path.resolve(url);
    if (!existsSync(original) || !statSync(original).isFile()) throw new Error(`No existe el archivo local: ${original}`);
    meta = { title: path.basename(original, path.extname(original)) };
    log('info', `Origen local verificado: ${original} (${(statSync(original).size / 1e6).toFixed(1)} MB)`);
  } else {
    ({ file: original, meta } = await downloadWithYtDlp(url, projectDir, {
      maxHeight,
      log,
      onProgress: (p) => onProgress(p * 0.45),
    }));
    log('info', `Descarga completa: ${path.basename(original)} (${(statSync(original).size / 1e6).toFixed(1)} MB)`);
  }
  onProgress(0.45);

  // 2. Análisis de streams.
  const probe = await probeMedia(original);
  log('info', `ffprobe: ${probe.width}x${probe.height} · ${probe.fps} fps${probe.variableFps ? ' (variable)' : ''} · ${probe.videoCodec}/${probe.audioCodec ?? 'sin audio'} · ${probe.durationSec.toFixed(1)} s`);
  if (!probe.hasAudio) throw new Error('El video no tiene pista de audio: no hay voz que transcribir.');
  onProgress(0.5);

  // 3. Audio mono 16 kHz para el transcriptor (50 → 60 %).
  const audio = path.join(projectDir, 'audio.wav');
  log('info', 'FFmpeg: extrayendo audio mono 16 kHz');
  await ffmpeg(['-i', original, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio], {
    totalSec: probe.durationSec,
    onProgress: (p) => onProgress(0.5 + p * 0.1),
  });

  // 4. Normalización a 30 fps constantes (60 → 100 %).
  let video = original;
  let normalized = false;
  if (probe.durationSec <= normalizeMaxSec) {
    video = path.join(projectDir, 'normalized.mp4');
    log('info', `FFmpeg: normalizando a ${FPS} fps constantes (H.264 yuv420p, AAC 48 kHz)`);
    let lastLogged = 0;
    await normalizeVideo(original, video, probe, {
      onProgress: (p) => {
        onProgress(0.6 + p * 0.4);
        if (p - lastLogged >= 0.2) {
          lastLogged = p;
          log('info', `FFmpeg: normalización ${Math.round(p * 100)} %`);
        }
      },
    });
    normalized = true;
  } else {
    log('warn', `Video de ${(probe.durationSec / 60).toFixed(1)} min (> ${normalizeMaxSec / 60} min): la normalización a ${FPS} fps se aplicará solo a la ventana elegida, en el reencuadre`);
  }
  const finalProbe = normalized ? await probeMedia(video) : probe;
  if (sourceType === 'local' && !normalized) {
    // El proyecto queda autocontenido aunque luego se mueva el original.
    const staged = path.join(projectDir, `source${path.extname(original)}`);
    if (!existsSync(staged)) copyFileSync(original, staged);
    video = staged;
  }

  return {
    meta,
    original,
    video,
    audio,
    normalized,
    durationSec: finalProbe.durationSec,
    width: finalProbe.width,
    height: finalProbe.height,
    fps: finalProbe.fps,
    videoCodec: finalProbe.videoCodec,
    pixFmt: finalProbe.pixFmt,
    audioCodec: finalProbe.audioCodec,
    sampleRate: finalProbe.sampleRate,
    sourceProbe: probe,
  };
}
