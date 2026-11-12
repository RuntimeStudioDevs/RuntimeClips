// Generador de Contact Sheets y Fotogramas Clave para inspección por IA multimodal.
//
// Extrae fotogramas en momentos estratégicos del clip (arranque, mitad y cierre)
// y genera:
// 1. contact-sheet.jpg: Cuadrícula horizontal (3x1) de 1080x640 para inspección rápida de IA.
// 2. cover.jpg: Portada en alta resolución 1080x1920 para miniatura en redes.

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { exec, requireTool } from './tools.mjs';

/**
 * Genera una hoja de contacto (contact-sheet) y portada para un video MP4.
 * @param {string} mp4Path - Ruta al video MP4
 * @param {string} [outDir] - Directorio de salida (por defecto junto al MP4)
 * @param {{ timestamps?: number[], log?: Function }} [options]
 * @returns {Promise<{ contactSheet: string, cover: string, timestamps: number[] }>}
 */
export async function generateContactSheet(mp4Path, outDir = null, { timestamps = null, log = () => {} } = {}) {
  const absPath = path.resolve(mp4Path);
  if (!existsSync(absPath)) {
    throw new Error(`Video no encontrado: ${absPath}`);
  }

  const targetDir = outDir ? path.resolve(outDir) : path.dirname(absPath);
  mkdirSync(targetDir, { recursive: true });

  const ffmpegTool = requireTool('ffmpeg');
  const ffprobeTool = requireTool('ffprobe');
  const baseName = path.basename(absPath, path.extname(absPath));

  // Obtener duración del video
  const { stdout } = await exec(
    ffprobeTool,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', absPath],
    { allowFail: false }
  );
  const durationSec = Number(JSON.parse(stdout || '{}').format?.duration || 30);

  // Momentos clave por defecto: a los 2s (arranque), 50% (cuerpo) y 85% (clímax/cierre)
  const times = timestamps && timestamps.length >= 3
    ? timestamps
    : [
        Math.min(2.0, durationSec * 0.1),
        Number((durationSec * 0.5).toFixed(2)),
        Number((durationSec * 0.85).toFixed(2)),
      ];

  const contactSheetPath = path.join(targetDir, `${baseName}-contact-sheet.jpg`);
  const coverPath = path.join(targetDir, `${baseName}-cover.jpg`);

  log('info', `Generando contact-sheet en t=[${times.join(', ')}] s…`);

  // 1. Extraer portada en t=2s (o primer timestamp) a 1080x1920
  await exec(
    ffmpegTool,
    ['-y', '-ss', String(times[0]), '-i', absPath, '-vframes', '1', '-q:v', '2', coverPath],
    { allowFail: false }
  );

  // 2. Extraer los 3 fotogramas y ensamblar el contact-sheet con hstack
  // Creamos miniaturas escaladas a 360x640 y las unimos en una tira de 1080x640
  const filterGraph = `[0:v]scale=360:640[v0];[1:v]scale=360:640[v1];[2:v]scale=360:640[v2];[v0][v1][v2]hstack=inputs=3[out]`;
  const tileArgs = [
    '-y',
    '-ss', String(times[0]), '-i', absPath,
    '-ss', String(times[1]), '-i', absPath,
    '-ss', String(times[2]), '-i', absPath,
    '-filter_complex', filterGraph,
    '-map', '[out]',
    '-vframes', '1',
    '-q:v', '3',
    contactSheetPath,
  ];

  await exec(ffmpegTool, tileArgs, { allowFail: false });

  log('info', `✔ Contact sheet listo: ${path.basename(contactSheetPath)}`);
  log('info', `✔ Portada lista: ${path.basename(coverPath)}`);

  return {
    contactSheet: contactSheetPath,
    cover: coverPath,
    timestamps: times,
  };
}
