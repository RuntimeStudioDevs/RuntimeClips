// Utilidades compartidas del pipeline: localización de binarios (FFmpeg,
// ffprobe, yt-dlp, Deno), ejecución de procesos con salida en streaming y el
// CLI fijado de HyperFrames. Todo corre en local; nada sale de la máquina.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Una sola versión del CLI para todos los comandos (package.json → config.hyperframes).
export const HF_VERSION = PKG.config.hyperframes;
export const FPS = 30;
export const CANVAS = { w: 1080, h: 1920 };

// Zonas seguras de Reels/TikTok sobre el lienzo 1080x1920
// (../video-maker/docs/instagram-reels.md): 14 % arriba, 35 % abajo, 6 % a los
// lados y la columna de botones a la derecha desde y ≈ 1100.
export const SAFE = { x0: 65, x1: 1015, y0: 270, y1: 1248, buttonsX: 960, buttonsY: 1100 };

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';
const ENV_OVERRIDE = { ffmpeg: 'FFMPEG_PATH', ffprobe: 'FFPROBE_PATH', 'yt-dlp': 'YTDLP_PATH', deno: 'DENO_PATH' };

function findInPath(name) {
  const res = spawnSync(IS_WIN ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) return null;
  const hit = res.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l && (!IS_WIN || /\.exe$/i.test(l)));
  return hit || null;
}

function findFile(dir, fileName, depth) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  if (entries.some((e) => e.isFile() && e.name.toLowerCase() === fileName)) return path.join(dir, fileName);
  if (depth <= 0) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findFile(path.join(dir, e.name), fileName, depth - 1);
    if (hit) return hit;
  }
  return null;
}

// winget instala los binarios en Packages/ pero una terminal ya abierta no ve
// el PATH nuevo: se buscan ahí directamente.
function findInWinget(name) {
  const base = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  let packages;
  try {
    packages = readdirSync(base);
  } catch {
    return null;
  }
  // Gyan.FFmpeg (build completo) antes que el FFmpeg recortado que acompaña a yt-dlp.
  packages.sort((a, b) => Number(b.startsWith('Gyan.')) - Number(a.startsWith('Gyan.')));
  for (const pkg of packages) {
    const hit = findFile(path.join(base, pkg), `${name}.exe`, 3);
    if (hit) return hit;
  }
  return null;
}

const toolCache = new Map();

/** Ruta absoluta del binario o null si no está instalado. */
export function findTool(name) {
  if (toolCache.has(name)) return toolCache.get(name);
  const override = process.env[ENV_OVERRIDE[name]];
  const found =
    (override && existsSync(override) ? override : null) ??
    findInPath(name + EXE) ??
    (IS_WIN ? findInWinget(name) : null);
  toolCache.set(name, found);
  return found;
}

export function requireTool(name) {
  const found = findTool(name);
  if (!found) {
    const hint = ENV_OVERRIDE[name] ? ` o define ${ENV_OVERRIDE[name]}` : '';
    throw new Error(`No se encontró "${name}". Instálalo y agrégalo al PATH${hint}.`);
  }
  return found;
}

let cachedEnv = null;

/** Entorno de los procesos hijos: binarios en el PATH y telemetría desactivada. */
export function toolEnv() {
  if (cachedEnv) return cachedEnv;
  const dirs = ['ffmpeg', 'yt-dlp', 'deno'].map(findTool).filter(Boolean).map((file) => path.dirname(file));
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  cachedEnv = {
    ...process.env,
    [pathKey]: [...new Set(dirs), process.env[pathKey] ?? ''].join(path.delimiter),
    // 100% local y privado: el CLI de HyperFrames no envía datos de uso.
    HYPERFRAMES_NO_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
  };
  return cachedEnv;
}

/**
 * Ejecuta un proceso y entrega stdout/stderr línea a línea (también separa por
 * \r, que es como FFmpeg y yt-dlp refrescan su progreso). Rechaza si el código
 * de salida no es 0, con las últimas líneas de stderr en el mensaje.
 */
export function exec(cmd, args, { cwd = ROOT, onStdout, onStderr, allowFail = false, stdoutEncoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: toolEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const tail = [];
    const lineReader = (onLine, keep) => {
      let buffer = '';
      return (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r\n|\n|\r/);
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          keep?.(line);
          onLine?.(line);
        }
      };
    };
    if (stdoutEncoding === 'buffer') {
      child.stdout.on('data', (chunk) => onStdout?.(chunk));
    } else {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', lineReader(onStdout, (line) => out.push(line)));
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', lineReader(onStderr, (line) => {
      tail.push(line);
      if (tail.length > 40) tail.shift();
    }));
    child.on('error', (err) => reject(new Error(`No se pudo ejecutar "${path.basename(cmd)}": ${err.message}`)));
    child.on('close', (code) => {
      const result = { code, stdout: out.join('\n'), stderr: tail.join('\n') };
      if (code === 0 || allowFail) return resolve(result);
      const detail = tail.slice(-6).join(' | ').slice(0, 600);
      reject(new Error(`${path.basename(cmd)} terminó con código ${code}${detail ? `: ${detail}` : ''}`));
    });
  });
}

/**
 * FFmpeg con progreso real: `-progress pipe:1` emite out_time_us, que se
 * convierte en fracción 0..1 sobre `totalSec`.
 */
export function ffmpeg(args, { totalSec = 0, onProgress, ...options } = {}) {
  return exec(requireTool('ffmpeg'), ['-y', '-hide_banner', '-v', 'error', '-nostats', '-progress', 'pipe:1', ...args], {
    ...options,
    onStdout: (line) => {
      const match = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (match && totalSec > 0) onProgress?.(Math.min(1, Number(match[1]) / 1e6 / totalSec), Number(match[1]) / 1e6);
    },
  });
}

const ratio = (text) => {
  const [num, den] = String(text || '0/1').split('/').map(Number);
  return den ? num / den : 0;
};

/** Streams y duración de un archivo de medios (ffprobe). */
export async function probeMedia(file) {
  const { stdout } = await exec(requireTool('ffprobe'), [
    '-v', 'error',
    '-show_entries',
    'stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,sample_rate,channels:stream_side_data=rotation:format=duration,size,bit_rate',
    '-of', 'json', file,
  ]);
  const data = JSON.parse(stdout);
  const video = data.streams.find((s) => s.codec_type === 'video');
  const audio = data.streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new Error(`${path.basename(file)} no tiene pista de video.`);
  // Un video de celular grabado en vertical llega como 1920x1080 + rotación 90°.
  const rotation = Math.abs(Number(video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0)) % 180;
  const [width, height] = rotation === 90 ? [video.height, video.width] : [video.width, video.height];
  const fps = ratio(video.avg_frame_rate) || ratio(video.r_frame_rate);
  return {
    durationSec: Number(Number(data.format.duration).toFixed(3)),
    sizeBytes: Number(data.format.size) || null,
    width,
    height,
    fps: Number(fps.toFixed(3)),
    // r_frame_rate ≠ avg_frame_rate delata fps variable (grabaciones de celular o pantalla).
    variableFps: Math.abs(ratio(video.r_frame_rate) - ratio(video.avg_frame_rate)) > 0.01,
    videoCodec: video.codec_name,
    pixFmt: video.pix_fmt,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name ?? null,
    sampleRate: audio ? Number(audio.sample_rate) : null,
    channels: audio?.channels ?? null,
  };
}

// En Windows `npx` es un .cmd y Node solo lo lanza a través de un shell. Se
// evita llamando a npx-cli.js con el propio ejecutable de Node, así los
// argumentos con espacios o comillas llegan intactos.
function npxCommand() {
  const cli = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ].find(existsSync);
  if (!cli) throw new Error('No se encontró npx junto a Node.js; reinstala Node.js 22+.');
  return [process.execPath, cli];
}

/** El CLI fijado de HyperFrames (transcripción local y render). */
export function hf(args, options) {
  const [node, cli] = npxCommand();
  return exec(node, [cli, '--yes', `hyperframes@${HF_VERSION}`, ...args], options);
}

/** Ajusta un tiempo a la rejilla de fotogramas. */
export const snap = (t) => Number((Math.round(t * FPS) / FPS).toFixed(4));

export const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

export const escapeHtml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const fmtClock = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
