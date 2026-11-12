// Nodo 5 — Full-Screen Reframe.
//
// Lleva la ventana elegida a pantalla completa 1080x1920 siguiendo la cara:
//
//   1. Detecta los cambios de plano (multicámara) y muestrea la ventana a 4 fps
//      buscando caras en local (UltraFace, ONNX).
//   2. Calcula escala (cover + un acercamiento moderado si la cara queda chica)
//      y la posición vertical que deja la cara en el tercio superior, dentro de
//      la zona segura y por encima de los subtítulos.
//   3. Traza el recorrido de la cámara plano a plano: en cada cambio de plano
//      corta al nuevo encuadre en el fotograma exacto; dentro del plano se queda
//      quieta mientras la cara no salga de una zona muerta y panea suave si se
//      desplaza.
//   4. Codifica el clip en una sola pasada (30 fps constantes, H.264 yuv420p,
//      AAC 48 kHz), que es lo que consume la composición.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CANVAS, FPS, ROOT, SAFE, clamp, exec, ffmpeg, probeMedia, requireTool } from './tools.mjs';

const MODEL_FILE = path.join(ROOT, 'models', 'version-RFB-320.onnx');
const MODEL_URL = 'https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB/raw/master/models/onnx/version-RFB-320.onnx';
const NET = { w: 320, h: 240 };
const SAMPLE_FPS = 4;
const SCENE_THRESHOLD = 0.3; // diferencia entre fotogramas que cuenta como cambio de plano
const SCORE_MIN = 0.75;
const NMS_IOU = 0.3;

// Encuadre sobre el lienzo.
const FACE_TARGET_Y = 700; // centro de la cara: tercio superior, lejos de la UI de arriba
const FACE_MIN_H = 250; // por debajo de esta altura (px de lienzo) se acerca la cámara
const MAX_ZOOM = 1.3; // más acercamiento ya se nota en la nitidez
const DEAD_ZONE = 0.12; // fracción del ancho del recorte que la cara puede moverse sin que la cámara reaccione
const CUT_DISTANCE = 0.45; // un salto mayor dentro del plano es otro orador: corte, no paneo
const PAN_SEC = 0.6;
const MAX_MOVES = 60;

const even = (v) => 2 * Math.round(v / 2);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

/** Descarga única del detector (1,2 MB). Solo baja el modelo; no sube nada. */
export async function ensureFaceModel(log = () => {}) {
  if (existsSync(MODEL_FILE)) return MODEL_FILE;
  log('info', 'Descargando el detector de caras UltraFace (1,2 MB, una sola vez)');
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar el modelo de caras`);
  mkdirSync(path.dirname(MODEL_FILE), { recursive: true });
  writeFileSync(MODEL_FILE, Buffer.from(await res.arrayBuffer()));
  return MODEL_FILE;
}

function iou(a, b) {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter);
}

/** Caras de un fotograma RGB de 320x240, en coordenadas normalizadas de la red. */
async function detectFaces(ort, session, rgb) {
  const plane = NET.w * NET.h;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = (rgb[i * 3] - 127) / 128;
    input[plane + i] = (rgb[i * 3 + 1] - 127) / 128;
    input[2 * plane + i] = (rgb[i * 3 + 2] - 127) / 128;
  }
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, NET.h, NET.w]) });
  const scores = out.scores.data;
  const boxes = out.boxes.data;
  const found = [];
  for (let i = 0; i < scores.length / 2; i++) {
    const score = scores[i * 2 + 1];
    if (score < SCORE_MIN) continue;
    found.push({ score, x1: boxes[i * 4], y1: boxes[i * 4 + 1], x2: boxes[i * 4 + 2], y2: boxes[i * 4 + 3] });
  }
  found.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const box of found) if (kept.every((k) => iou(k, box) < NMS_IOU)) kept.push(box);
  return kept;
}

/** Tiempos (s, relativos a la ventana) en los que cambia el plano. */
async function detectShotChanges(video, startSec, durationSec) {
  const times = [];
  await exec(requireTool('ffmpeg'), [
    '-hide_banner', '-v', 'error', '-nostdin',
    '-ss', String(startSec), '-t', String(durationSec), '-i', video,
    '-vf', `scale=320:-2,select='gt(scene,${SCENE_THRESHOLD})',metadata=print:file=-`,
    '-an', '-f', 'null', '-',
  ], {
    onStdout: (line) => {
      const match = /pts_time:([\d.]+)/.exec(line);
      if (match && Number(match[1]) > 0.2 && Number(match[1]) < durationSec - 0.2) times.push(Number(match[1]));
    },
  });
  // Un fundido dispara varios fotogramas seguidos: cuenta como un solo cambio.
  return times.filter((t, i) => i === 0 || t - times[i - 1] > 0.4);
}

/**
 * Muestrea la ventana y devuelve, por muestra, las caras detectadas en píxeles
 * del video original: `{ t, faces: [{ x, y, w, h }] }`.
 */
async function sampleFaces(video, src, startSec, durationSec, { log, onProgress }) {
  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(await ensureFaceModel(log), { logSeverityLevel: 3 });

  // Letterbox a 320x240 sin deformar: la red ve las caras con su proporción real.
  const fit = Math.min(NET.w / src.width, NET.h / src.height);
  const drawn = { w: even(src.width * fit), h: even(src.height * fit) };
  const pad = { x: Math.floor((NET.w - drawn.w) / 2), y: Math.floor((NET.h - drawn.h) / 2) };
  const frameBytes = NET.w * NET.h * 3;
  const total = Math.max(1, Math.floor(durationSec * SAMPLE_FPS));

  const samples = [];
  let pending = Buffer.alloc(0);
  let queue = Promise.resolve();
  await exec(requireTool('ffmpeg'), [
    '-hide_banner', '-v', 'error', '-nostdin',
    '-ss', String(startSec), '-t', String(durationSec), '-i', video,
    '-vf', `fps=${SAMPLE_FPS},scale=${drawn.w}:${drawn.h},pad=${NET.w}:${NET.h}:${pad.x}:${pad.y}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], {
    stdoutEncoding: 'buffer',
    onStdout: (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameBytes) {
        const rgb = Buffer.from(pending.subarray(0, frameBytes));
        pending = pending.subarray(frameBytes);
        // Las inferencias se encadenan para conservar el orden de los fotogramas.
        queue = queue.then(async () => {
          const faces = (await detectFaces(ort, session, rgb)).map((b) => ({
            x: ((b.x1 + b.x2) / 2 * NET.w - pad.x) / fit,
            y: ((b.y1 + b.y2) / 2 * NET.h - pad.y) / fit,
            w: (b.x2 - b.x1) * NET.w / fit,
            h: (b.y2 - b.y1) * NET.h / fit,
          }));
          samples.push({ t: samples.length / SAMPLE_FPS, faces });
          onProgress?.(Math.min(1, samples.length / total));
        });
      }
    },
  });
  await queue;
  await session.release?.();
  return samples;
}

/** Parte las muestras en planos y elige la cara principal de cada muestra. */
function splitShots(samples, shotChanges, durationSec) {
  const bounds = [0, ...shotChanges, durationSec];
  return bounds.slice(0, -1).map((start, i) => {
    const end = bounds[i + 1];
    let previous = null;
    const picked = samples.filter((s) => s.t >= start && s.t < end).map((s) => {
      // Cara principal: la más grande; se mantiene la anterior salvo que otra sea claramente mayor.
      let main = [...s.faces].sort((a, b) => b.w * b.h - a.w * a.h)[0] ?? null;
      if (main && previous) {
        const same = s.faces.reduce((best, f) => (Math.abs(f.x - previous.x) < Math.abs(best.x - previous.x) ? f : best), main);
        if (same !== main && main.w * main.h < same.w * same.h * 1.3) main = same;
      }
      if (main) previous = main;
      return main ? { t: s.t, ...main } : null;
    });
    return { start, end, samples: picked, known: picked.filter(Boolean) };
  });
}

/**
 * Recorrido de la cámara (centro del recorte, en px de la fuente). Devuelve la
 * posición inicial y los movimientos `{ t, axis, delta, to, cut }`.
 */
function planCamera(shots, crop, src) {
  const limit = (v, size, max) => clamp(v, size / 2, Math.max(size / 2, max - size / 2));
  const center = { x: src.width / 2, y: src.height / 2 };
  const moves = [];
  let first = null;
  let camera = null;

  for (const shot of shots) {
    // Plano sin cara (público, diapositiva, plano general): encuadre centrado.
    let start = center;
    let smooth = [];
    if (shot.known.length) {
      // Huecos rellenos con la última cara vista y mediana de ~1 s contra detecciones sueltas.
      let last = shot.known[0].x;
      const filled = shot.samples.map((s) => (s ? (last = s.x) : last));
      smooth = filled.map((_, i) => median(filled.slice(Math.max(0, i - 2), i + 3)));
      start = {
        x: limit(median(smooth.slice(0, 5)), crop.w, src.width),
        y: limit(median(shot.known.map((f) => f.y)) - crop.faceOffsetY, crop.h, src.height),
      };
    }
    if (!camera) {
      camera = { ...start };
      first = { ...start };
    } else {
      // Cambio de plano: corte en el fotograma exacto.
      for (const axis of ['x', 'y']) {
        if (Math.abs(start[axis] - camera[axis]) < 1) continue;
        moves.push({ t: Number((shot.start - 0.001).toFixed(3)), axis, delta: start[axis] - camera[axis], to: Math.round(start[axis]), cut: true });
        camera[axis] = start[axis];
      }
    }
    // Dentro del plano: quieta en la zona muerta, paneo si la cara se va.
    let busyUntil = shot.start;
    smooth.forEach((x, i) => {
      const t = shot.start + i / SAMPLE_FPS;
      const target = limit(x, crop.w, src.width);
      if (t < busyUntil || Math.abs(target - camera.x) <= crop.w * DEAD_ZONE) return;
      const cut = Math.abs(target - camera.x) > crop.w * CUT_DISTANCE;
      // El movimiento se adelanta para estar ya en su sitio cuando la cara llega.
      const at = Math.max(shot.start, t - (cut ? 0.5 / SAMPLE_FPS : PAN_SEC / 2));
      moves.push({ t: Number(at.toFixed(3)), axis: 'x', delta: target - camera.x, to: Math.round(target), cut });
      camera.x = target;
      busyUntil = t + (cut ? 0.5 : PAN_SEC + 0.5);
    });
  }
  return { start: first ?? center, moves };
}

const ease = (m, t) => {
  if (m.cut) return Number(t >= m.t);
  const u = clamp((t - m.t) / PAN_SEC, 0, 1);
  return (3 - 2 * u) * u * u;
};

/** Centro del recorte en el instante t. */
function cameraAt(camera, t) {
  const at = { ...camera.start };
  for (const m of camera.moves) at[m.axis] += m.delta * ease(m, t);
  return at;
}

// p(t) = p0 + Σ Δᵢ·ease((t − tᵢ)/d): suma plana de términos, sin anidar condiciones.
function cropExpression(p0, moves, scale, max) {
  if (!moves.length) return String(Math.round(clamp(p0, 0, max)));
  const terms = moves.map((m) => {
    const delta = (m.delta * scale).toFixed(2);
    if (m.cut) return `${delta}*gte(t,${m.t})`;
    const u = `clip((t-${m.t})/${PAN_SEC},0,1)`;
    return `${delta}*(3-2*${u})*${u}*${u}`;
  });
  return `'clip(${[p0.toFixed(2), ...terms].join('+').replaceAll('+-', '-')},0,${max})'`;
}

/**
 * @param {{ video: string, startSec: number, endSec: number, output: string, options?: object }} input
 * @returns datos del encuadre: escala, recorte, posición de la cara en el lienzo, movimientos y márgenes seguros
 */
export async function reframe({ video, startSec, endSec, output, options = {} }, { log, onProgress }) {
  const src = await probeMedia(video);
  const durationSec = Number((endSec - startSec).toFixed(4));

  // 1. Cambios de plano y detección de caras (0 → 30 % de la barra).
  let samples = [];
  let shotChanges = [];
  let detector = 'ultraface-rfb-320';
  try {
    shotChanges = await detectShotChanges(video, startSec, durationSec);
    log('info', shotChanges.length ? `${shotChanges.length + 1} planos (cambios en ${shotChanges.map((t) => t.toFixed(1)).join(', ')} s)` : 'Un solo plano continuo');
    onProgress(0.08);
    log('info', `Detectando caras a ${SAMPLE_FPS} fps en la ventana de ${durationSec.toFixed(1)} s`);
    samples = await sampleFaces(video, src, startSec, durationSec, { log, onProgress: (p) => onProgress(0.08 + p * 0.22) });
  } catch (err) {
    detector = null;
    samples = [];
    log('warn', `Detector de caras no disponible (${err.message}): se usa encuadre centrado`);
  }
  const shots = splitShots(samples, shotChanges, durationSec);
  const known = shots.flatMap((shot) => shot.known);
  const coverage = samples.length ? known.length / samples.length : 0;
  onProgress(0.3);

  // 2. Escala.
  const cover = Math.max(CANVAS.w / src.width, CANVAS.h / src.height);
  const useFaces = known.length >= Math.max(2, samples.length * 0.15);
  const faceH = useFaces ? median(known.map((f) => f.h)) : null;
  const zoom = useFaces && options.zoom !== false ? clamp(FACE_MIN_H / (faceH * cover), 1, MAX_ZOOM) : 1;
  const scale = cover * zoom;
  const scaled = { w: Math.max(CANVAS.w, even(src.width * scale)), h: Math.max(CANVAS.h, even(src.height * scale)) };
  const maxX = scaled.w - CANVAS.w;
  const maxY = scaled.h - CANVAS.h;
  // Recorte en px de la fuente; faceOffsetY lleva la cara de su centro a FACE_TARGET_Y.
  const crop = { w: CANVAS.w / scale, h: CANVAS.h / scale, faceOffsetY: (FACE_TARGET_Y - CANVAS.h / 2) / scale };

  // 3. Recorrido de la cámara.
  let camera = { start: { x: src.width / 2, y: src.height / 2 }, moves: [] };
  if (useFaces) {
    camera = planCamera(shots, crop, src);
    if (options.staticCrop || camera.moves.length > MAX_MOVES) {
      if (!options.staticCrop) log('warn', `Demasiado movimiento (${camera.moves.length} cambios): se fija el encuadre en la posición más frecuente`);
      camera = {
        start: {
          x: clamp(median(known.map((f) => f.x)), crop.w / 2, Math.max(crop.w / 2, src.width - crop.w / 2)),
          y: clamp(median(known.map((f) => f.y)) - crop.faceOffsetY, crop.h / 2, Math.max(crop.h / 2, src.height - crop.h / 2)),
        },
        moves: [],
      };
    }
    log('info', `Cara principal en ${Math.round(coverage * 100)} % de las muestras · altura ${Math.round(faceH)} px → ${Math.round(faceH * scale)} px en lienzo (zoom ${zoom.toFixed(2)}×)`);
    const pans = camera.moves.filter((m) => !m.cut).length;
    const cuts = new Set(camera.moves.filter((m) => m.cut).map((m) => m.t)).size;
    log('info', camera.moves.length ? `Cámara: ${cuts} cortes de plano y ${pans} paneos` : 'Cámara fija: la cara no sale de la zona muerta');
  } else {
    log('warn', samples.length ? 'No se detectó una cara estable: encuadre centrado' : 'Sin detección: encuadre centrado');
  }
  const x0 = camera.start.x * scale - CANVAS.w / 2;
  const y0 = camera.start.y * scale - CANVAS.h / 2;
  const cropX = cropExpression(x0, camera.moves.filter((m) => m.axis === 'x'), scale, maxX);
  const cropY = cropExpression(y0, camera.moves.filter((m) => m.axis === 'y'), scale, maxY);

  // 4. Recorte + normalización en una sola codificación (30 → 100 %).
  log('info', `FFmpeg: ${src.width}x${src.height} → escala ${scaled.w}x${scaled.h} → recorte ${CANVAS.w}x${CANVAS.h} a ${FPS} fps`);
  let lastLogged = 0;
  await ffmpeg([
    '-ss', String(startSec), '-t', String(durationSec), '-i', video,
    '-vf', `scale=${scaled.w}:${scaled.h}:flags=lanczos,crop=${CANVAS.w}:${CANVAS.h}:${cropX}:${cropY},fps=${FPS},setsar=1`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17',
    '-g', String(FPS), '-keyint_min', String(FPS), '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    output,
  ], {
    totalSec: durationSec,
    onProgress: (p) => {
      onProgress(0.3 + p * 0.7);
      if (p - lastLogged >= 0.25) {
        lastLogged = p;
        log('info', `FFmpeg: reencuadre ${Math.round(p * 100)} %`);
      }
    },
  });

  // 5. Dónde quedó la cara en el lienzo y cuánto margen tiene hasta la UI.
  const out = await probeMedia(output);
  let face = null;
  let inSafeZone = null;
  if (useFaces) {
    // Posición de la cámara en cada muestra, para medir el encuadre real.
    const placed = known.map((f) => {
      const at = cameraAt(camera, f.t);
      const left = clamp(at.x * scale - CANVAS.w / 2, 0, maxX);
      const top = clamp(at.y * scale - CANVAS.h / 2, 0, maxY);
      return { x: f.x * scale - left, y: f.y * scale - top, w: f.w * scale, h: f.h * scale };
    });
    // La cara entera dentro del lienzo y su centro dentro de la zona segura.
    const inside = placed.filter((f) =>
      f.x - f.w / 2 >= 0 && f.x + f.w / 2 <= CANVAS.w && f.y >= SAFE.y0 && f.y + f.h / 2 <= SAFE.y1);
    inSafeZone = Number((inside.length / placed.length).toFixed(3));
    const center = { x: Math.round(median(placed.map((f) => f.x))), y: Math.round(median(placed.map((f) => f.y))) };
    const size = { w: Math.round(median(placed.map((f) => f.w))), h: Math.round(median(placed.map((f) => f.h))) };
    face = {
      center,
      size,
      margins: {
        top: Math.round(center.y - size.h / 2 - SAFE.y0),
        bottom: Math.round(SAFE.y1 - (center.y + size.h / 2)),
        left: Math.round(center.x - size.w / 2 - SAFE.x0),
        right: Math.round(SAFE.x1 - (center.x + size.w / 2)),
      },
    };
    log('info', `Cara en el lienzo: centro (${center.x}, ${center.y}) · ${size.w}x${size.h} px · bien encuadrada en ${Math.round(inSafeZone * 100)} % de las muestras`);
    if (face.margins.top < 0 && maxY === 0) {
      log('warn', `La frente queda ${-face.margins.top} px dentro de la franja superior de la UI: el video original no tiene más altura para bajar la cara`);
    }
  }

  return {
    output,
    resolution: `${out.width}x${out.height}`,
    fps: out.fps,
    durationSec: out.durationSec,
    detector,
    samples: samples.length,
    shots: shots.length,
    faceCoverage: Number(coverage.toFixed(3)),
    source: { width: src.width, height: src.height },
    scale: Number(scale.toFixed(4)),
    zoom: Number(zoom.toFixed(3)),
    crop: { x: Math.round(clamp(x0, 0, maxX)), y: Math.round(clamp(y0, 0, maxY)), w: CANVAS.w, h: CANVAS.h, scaledWidth: scaled.w, scaledHeight: scaled.h },
    cameraMoves: camera.moves.map(({ t, axis, to, cut }) => ({ atSec: t, axis, toSource: to, type: cut ? 'corte' : 'paneo' })),
    face,
    inSafeZone,
    safeZone: SAFE,
  };
}
