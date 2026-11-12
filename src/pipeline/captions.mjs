// Nodo 7 — Karaoke Captions.
//
// Agrupa las palabras del clip en líneas cortas y genera
// compositions/captions.html desde la plantilla: cada grupo aparece cuando se
// dice su primera palabra y la palabra activa se resalta en su instante exacto.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CANVAS, FPS, ROOT, SAFE, escapeHtml, snap } from './tools.mjs';

// Franja de subtítulos: zona segura media-baja, por debajo de la banda de
// overlays y por encima del 35 % inferior que tapa la UI.
export const CAPTIONS_ZONE = { top: 1070, height: 160 };
// A esa altura ya existe la columna de botones: el texto no pasa de x 955.
const PAD_X = CANVAS.w - (SAFE.buttonsX - 5);
const MAX_TEXT_W = CANVAS.w - 2 * PAD_X;

const MAX_WORDS = 3;
const SIZE = 76;
const MIN_SIZE = 56; // ~40 px de altura de mayúscula: el mínimo legible en un celular
const CHAR_EM = 0.68; // avance medio de una mayúscula en Inter Black
const PAUSE = 0.3; // un silencio así de largo cierra el grupo
const HOLD = 0.25; // el grupo se queda un momento tras su última palabra...
const TAIL = 0.6; // ...y el último, un poco más

/** Grupos `{ start, end, size, words: [{ text, on, off }] }` en segundos del clip. */
export function groupWords(words, durationSec) {
  const maxChars = Math.floor(MAX_TEXT_W / (SIZE * CHAR_EM));
  const groups = [];
  let current = [];
  const flush = () => {
    if (current.length) groups.push(current);
    current = [];
  };
  words.forEach((word, i) => {
    const candidate = [...current, word];
    const length = candidate.map((w) => w.text).join(' ').length;
    if (current.length && (candidate.length > MAX_WORDS || length > maxChars)) {
      flush();
      current = [word];
    } else {
      current.push(word);
    }
    const next = words[i + 1];
    if (!next || /[.,;:!?…]$/.test(word.text) || next.start - word.end >= PAUSE) flush();
  });
  flush();

  return groups.map((group, i) => {
    const next = groups[i + 1];
    const start = group[0].start;
    const last = group[group.length - 1];
    const end = next ? Math.min(next[0].start, last.end + HOLD) : Math.min(durationSec, last.end + TAIL);
    const text = group.map((w) => w.text).join(' ');
    const fit = Math.floor(MAX_TEXT_W / (text.length * CHAR_EM));
    return {
      start: snap(start),
      end: snap(Math.max(end, start + 2 / FPS)),
      size: Math.max(MIN_SIZE, Math.min(SIZE, fit)),
      words: group.map((w, wi) => {
        const nextWord = group[wi + 1];
        // Sin pausa entre palabras, el resaltado pasa de una a la siguiente sin apagarse.
        const off = nextWord && nextWord.start - w.end < PAUSE ? nextWord.start : w.end;
        return { text: w.text, on: snap(w.start), off: snap(Math.max(off, w.start + 2 / FPS)) };
      }),
    };
  });
}

/**
 * @param {{ projectDir: string, words: Array<{text, start, end}>, durationSec: number }} input
 *   `words` con tiempos relativos al inicio del clip.
 */
export function buildCaptions({ projectDir, words, durationSec }, { log = () => {} } = {}) {
  // La coma y el punto finales no se muestran: en karaoke solo ensucian la línea.
  const clean = words
    .map((w) => ({ ...w, text: w.text.replace(/[.,;:]+$/, '').replace(/^["'“«]+|["'”»]+$/g, '') }))
    .filter((w) => w.text);
  const groups = groupWords(clean, durationSec);
  const tooLong = groups.filter((g) => g.size === MIN_SIZE && g.words.map((w) => w.text).join(' ').length * MIN_SIZE * CHAR_EM > MAX_TEXT_W);
  for (const g of tooLong) log('warn', `Subtítulo muy largo en ${g.start}s ("${g.words.map((w) => w.text).join(' ')}")`);

  const markup = groups
    .map((g, gi) =>
      `        <div class="cap-group" id="captions-g${gi}"><div class="cap-line" style="font-size: ${g.size}px">` +
      g.words.map((w, wi) => `<span id="captions-g${gi}-w${wi}">${escapeHtml(w.text)}</span>`).join('') +
      '</div></div>')
    .join('\n');
  const data = JSON.stringify(groups.map((g) => [g.start, g.end, g.words.map((w) => [w.on, w.off])]));

  const html = readFileSync(path.join(ROOT, 'src', 'template', 'compositions', 'captions.html'), 'utf8')
    .replaceAll('{{GROUPS_HTML}}', () => markup)
    .replaceAll('{{DATA}}', () => data)
    .replaceAll('{{HEIGHT}}', String(CAPTIONS_ZONE.height))
    .replaceAll('{{PAD_LEFT}}', String(PAD_X))
    .replaceAll('{{PAD_RIGHT}}', String(PAD_X));
  writeFileSync(path.join(projectDir, 'compositions', 'captions.html'), html);

  log('info', `${clean.length} palabras en ${groups.length} líneas de hasta ${MAX_WORDS} palabras`);
  log('info', `Franja de subtítulos y ${CAPTIONS_ZONE.top}–${CAPTIONS_ZONE.top + CAPTIONS_ZONE.height} px, texto en x ${PAD_X}–${CANVAS.w - PAD_X} px (zona segura)`);
  return {
    lines: groups.length,
    words: clean.length,
    fontSize: SIZE,
    style: 'karaoke: blanco con contorno negro, palabra activa en color de acento',
    zone: { x0: PAD_X, x1: CANVAS.w - PAD_X, y0: CAPTIONS_ZONE.top, y1: CAPTIONS_ZONE.top + CAPTIONS_ZONE.height },
    safeZone: 'media-baja',
    preview: groups.slice(0, 4).map((g) => ({ start: g.start, end: g.end, text: g.words.map((w) => w.text).join(' ') })),
  };
}
