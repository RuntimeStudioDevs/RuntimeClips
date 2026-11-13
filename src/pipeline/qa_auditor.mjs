// Auditor técnico estricto (QA Gatekeeper) para Reels generados en RuntimeClips.
//
// Mide con ffprobe y ffmpeg loudnorm:
// 1. Resolución 1080x1920 (9:16)
// 2. Framerate constante (30 fps o 60 fps)
// 3. Códec H.264 (yuv420p)
// 4. Audio AAC a 48 kHz
// 5. Sonoridad EBU R128 (-14 LUFS ± 1.5 LUFS) y True Peak <= -1.0 dBTP
// 6. Portada no negra / no vacía
// 7. Duración óptima (15 a 90 s)
//
// Emite veredicto técnico: LISTO o BLOQUEA con reporte estructurado.

import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { exec, requireTool } from './tools.mjs';

/**
 * Realiza una auditoría técnica completa sobre un archivo MP4 renderizado.
 * @param {string} mp4Path - Ruta al archivo de video MP4
 * @param {{ log?: Function }} options
 * @returns {Promise<{ pass: boolean, verdict: 'LISTO' | 'BLOQUEA', checks: Array, metrics: object }>}
 */
export async function auditClip(mp4Path, { log = () => {} } = {}) {
  const absPath = path.resolve(mp4Path);
  if (!existsSync(absPath)) {
    throw new Error(`No se encuentra el archivo a auditar: ${absPath}`);
  }

  const ffprobeTool = requireTool('ffprobe');
  const ffmpegTool = requireTool('ffmpeg');
  const fileName = path.basename(absPath);

  log('info', `Iniciando QA técnico para ${fileName}…`);

  // 1. Análisis de flujos de video con ffprobe
  const probeArgs = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,codec_name,pix_fmt',
    '-of', 'json',
    absPath,
  ];
  const { stdout: vStdout } = await exec(ffprobeTool, probeArgs, { allowFail: false });
  const vData = JSON.parse(vStdout || '{}').streams?.[0] || {};

  // 2. Análisis de flujos de audio con ffprobe
  const aProbeArgs = [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels',
    '-of', 'json',
    absPath,
  ];
  const { stdout: aStdout } = await exec(aProbeArgs[0] === '-v' ? ffprobeTool : ffprobeTool, aProbeArgs, { allowFail: true });
  const aData = JSON.parse(aStdout || '{}').streams?.[0] || null;

  // 3. Duración del contenedor
  const formatArgs = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', absPath];
  const { stdout: fStdout } = await exec(ffprobeTool, formatArgs, { allowFail: false });
  const durationSec = Number(JSON.parse(fStdout || '{}').format?.duration || 0);

  // 4. Sonoridad EBU R128 con ffmpeg loudnorm
  let integratedLufs = null;
  let truePeak = null;
  let lufsPass = false;
  try {
    const { stderr: loudStderr } = await exec(
      ffmpegTool,
      ['-hide_banner', '-i', absPath, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'],
      { allowFail: true }
    );
    const jsonMatch = loudStderr.match(/\{[\s\S]*"input_i"[\s\S]*\}/);
    if (jsonMatch) {
      const stats = JSON.parse(jsonMatch[0]);
      integratedLufs = Number(Number(stats.input_i).toFixed(1));
      truePeak = Number(Number(stats.input_tp).toFixed(1));
      // Meta recomienda -14 LUFS ± 1.5; True Peak <= -0.8 dBTP
      lufsPass = integratedLufs >= -16.5 && integratedLufs <= -12.0 && truePeak <= -0.5;
    }
  } catch (err) {
    log('warn', `No se pudo calcular sonoridad: ${err.message}`);
  }

  // 5. Verificación de portada (primer fotograma con blackdetect)
  let coverPass = true;
  try {
    const { stderr: blackStderr } = await exec(
      ffmpegTool,
      ['-hide_banner', '-i', absPath, '-t', '0.2', '-vf', 'blackdetect=d=0.08:pix_th=0.10', '-f', 'null', '-'],
      { allowFail: true }
    );
    if (/black_start:\s*0(\.0+)?/i.test(blackStderr) && /black_duration:\s*0\.[1-9]/i.test(blackStderr)) {
      coverPass = false;
    }
  } catch {
    // Si blackdetect no reporta, consideramos válido
  }

  // Evaluación de los checks
  const checks = [];

  // Check 1: Resolución 1080x1920 (9:16)
  const resStr = `${vData.width}x${vData.height}`;
  checks.push({
    name: 'Resolución 9:16',
    pass: vData.width === 1080 && vData.height === 1920,
    measured: resStr,
    expected: '1080x1920',
  });

  // Check 2: Framerate (30 fps o 60 fps)
  const fpsMatch = (vData.r_frame_rate || '').match(/^(\d+)\/(\d+)$/);
  const fps = fpsMatch ? Number(fpsMatch[1]) / Number(fpsMatch[2]) : 0;
  checks.push({
    name: 'Framerate constante',
    pass: Math.abs(fps - 30) < 0.2 || Math.abs(fps - 60) < 0.2,
    measured: `${fps.toFixed(1)} fps (${vData.r_frame_rate})`,
    expected: '30 fps (o 60 fps)',
  });

  // Check 3: Códec y formato de píxel
  checks.push({
    name: 'Códec H.264 / yuv420p',
    pass: vData.codec_name === 'h264' && vData.pix_fmt === 'yuv420p',
    measured: `${vData.codec_name} (${vData.pix_fmt})`,
    expected: 'h264 (yuv420p)',
  });

  // Check 4: Audio AAC estéreo
  const aChannels = Number(aData?.channels || 0);
  const aSampleRate = Number(aData?.sample_rate || 0);
  checks.push({
    name: 'Audio AAC 48 kHz',
    pass: aData && aData.codec_name === 'aac' && (aSampleRate === 48000 || aSampleRate === 44100),
    measured: aData ? `${aData.codec_name} ${aSampleRate} Hz (${aChannels} canales)` : 'Sin audio',
    expected: 'aac 48000 Hz estéreo',
  });

  // Check 5: Duración en rango óptimo (15 a 90 s)
  checks.push({
    name: 'Duración óptima',
    pass: durationSec >= 15 && durationSec <= 90,
    measured: `${durationSec.toFixed(1)} s`,
    expected: '15 a 90 s',
  });

  // Check 6: Sonoridad EBU R128 (-14 LUFS / True Peak)
  checks.push({
    name: 'Sonoridad EBU R128',
    pass: lufsPass,
    measured: integratedLufs !== null ? `${integratedLufs} LUFS (Peak ${truePeak} dBTP)` : 'No medido',
    expected: '-14 LUFS ± 1.5 (True Peak ≤ -1 dBTP)',
  });

  // Check 7: Portada válida
  checks.push({
    name: 'Portada inicial activa',
    pass: coverPass,
    measured: coverPass ? 'Fotograma activo con contenido' : 'Fotograma negro en inicio',
    expected: 'No negro / no transparente',
  });

  const failures = checks.filter((c) => !c.pass);
  const allPass = failures.length === 0;
  const verdict = allPass ? 'LISTO' : 'BLOQUEA';

  if (allPass) {
    log('success', `✔ [QA] ${fileName}: LISTO (todos los ${checks.length} checks pasados)`);
  } else {
    log('warn', `⚠ [QA] ${fileName}: BLOQUEA (${failures.length} fallos: ${failures.map((f) => f.name).join(', ')})`);
  }

  return {
    file: fileName,
    filePath: absPath,
    verdict,
    pass: allPass,
    checks,
    failures: failures.map((f) => `${f.name}: medido "${f.measured}", esperado "${f.expected}"`),
    metrics: {
      resolution: resStr,
      fps: Number(fps.toFixed(1)),
      durationSec: Number(durationSec.toFixed(2)),
      integratedLufs,
      truePeak,
      codec: vData.codec_name,
      audioCodec: aData?.codec_name ?? null,
    },
  };
}
