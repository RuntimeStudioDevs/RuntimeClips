// Módulo de empaquetado ZIP para el pipeline de RuntimeClips.
//
// Empaqueta todos los clips .mp4 generados en un archivo comprimido .zip
// utilizando el soporte nativo del sistema (tar / bsdtar en Windows y Unix)
// o PowerShell Compress-Archive como respaldo.

import { statSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { exec, findTool } from './tools.mjs';

/**
 * Empaqueta una lista de archivos en un único archivo .zip
 * @param {Array<{ path: string, name?: string } | string>} files - Lista de archivos a incluir
 * @param {string} outZipPath - Ruta del archivo .zip de salida
 * @param {{ log?: Function }} options
 * @returns {Promise<{ zipPath: string, zipFile: string, sizeMb: number, fileCount: number }>}
 */
export async function createZipArchive(files, outZipPath, { log = () => {} } = {}) {
  const absZipPath = path.resolve(outZipPath);
  const outDir = path.dirname(absZipPath);
  mkdirSync(outDir, { recursive: true });

  const existingFiles = files
    .map((f) => (typeof f === 'string' ? path.resolve(f) : path.resolve(f.path)))
    .filter((fp) => existsSync(fp));

  if (!existingFiles.length) {
    throw new Error('No hay archivos válidos para empaquetar en el .zip');
  }

  const zipFile = path.basename(absZipPath);
  log('info', `Empaquetando ${existingFiles.length} clips en ${zipFile}…`);

  // Estrategia 1: tar -a -cf <absZipPath> -C <dir> <files...>
  const tarTool = findTool('tar') || 'tar';
  try {
    // Para que los archivos queden en la raíz del ZIP sin rutas completas
    // tomamos el directorio común o los añadimos con -C
    const args = ['-a', '-c', '-f', absZipPath];
    for (const file of existingFiles) {
      args.push('-C', path.dirname(file), path.basename(file));
    }
    await exec(tarTool, args, { allowFail: false });
  } catch (tarErr) {
    log('warn', `tar falló (${tarErr.message}), intentando con PowerShell Compress-Archive…`);
    // Estrategia 2: PowerShell Compress-Archive (Windows fallback)
    const escapedSources = existingFiles.map((p) => `'${p.replaceAll("'", "''")}'`).join(',');
    const psCmd = `Compress-Archive -Path ${escapedSources} -DestinationPath '${absZipPath.replaceAll("'", "''")}' -Force`;
    await exec('powershell', ['-NoProfile', '-Command', psCmd], { allowFail: false });
  }

  if (!existsSync(absZipPath)) {
    throw new Error(`El archivo ZIP no se creó en ${absZipPath}`);
  }

  const stats = statSync(absZipPath);
  const sizeMb = Number((stats.size / (1024 * 1024)).toFixed(2));
  log('info', `✔ Archivo ZIP creado con éxito: ${zipFile} (${sizeMb} MB, ${existingFiles.length} clips)`);

  return {
    zipPath: absZipPath,
    zipFile,
    sizeMb,
    fileCount: existingFiles.length,
  };
}
