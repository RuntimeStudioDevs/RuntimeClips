// Nodo 6 — Motion Overlays.
//
// Planifica los motion graphics desde el transcript del clip (sin IA externa,
// determinista) y escribe una subcomposición GSAP transparente por overlay:
//
//   progress-bar   barra de avance en el borde superior, todo el clip
//   kinetic-title  titular del gancho en los primeros segundos
//   stat-counter   cifra animada cuando se dice un número
//   keyword-badge  píldora cuando se dice una palabra de impacto
//
// Todos viven en la misma banda (entre la cara y los subtítulos) y nunca se
// pisan en el tiempo.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, escapeHtml, snap } from './tools.mjs';
import { POWER } from './hook_detector.mjs';

// Banda de overlays sobre el lienzo: debajo de la cara, encima de los subtítulos.
export const OVERLAY_BAND = { top: 880, height: 180 };

const GAP = 2.5; // respiro mínimo entre dos overlays
const TITLE_MAX_WORDS = 6;
const STAT_SEC = 2.8;
const BADGE_SEC = 2.2;

// Palabras de impacto que puntúan en el gancho pero, sueltas en una píldora, no dicen nada.
const BADGE_SKIP = new Set(`
  resulta gente todos siempre nunca nadie jamás vida mundo nuevo primero primera último mejor peor único
  mil millón millones historia razón people everyone always never nobody new first last only best worst
  thousand million millions story reason life world
`.split(/\s+/).filter(Boolean));

const bare = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const strip = (text) => text.replace(/^[^\p{L}\p{N}$€%]+|[^\p{L}\p{N}%]+$/gu, '');
const endsPhrase = (text) => /[.,;:!?…]$/.test(text);

function planTitle(words, durationSec) {
  if (!words.length || durationSec < 6) return null;
  let last = 0;
  while (last < words.length - 1 && last < TITLE_MAX_WORDS - 1 && !/[.!?…]$/.test(words[last].text)) last++;
  const picked = words.slice(0, last + 1);
  const truncated = !/[.!?…]$/.test(picked[picked.length - 1].text) && last < words.length - 1;
  const texts = picked.map((w) => strip(w.text)).filter(Boolean);
  if (!texts.length) return null;
  if (truncated) texts[texts.length - 1] += '…';
  // Se acentúa la cifra o la palabra de impacto; si no hay, la última.
  let accent = picked.findIndex((w) => /\d/.test(w.text) || POWER.has(bare(w.text)));
  if (accent < 0) accent = texts.length - 1;
  const chars = texts.join(' ').length;
  const start = 0.25;
  const end = Math.min(durationSec - 0.5, Math.max(2.8, Math.min(4.5, picked[picked.length - 1].end + 0.6)));
  return {
    type: 'kinetic-title',
    start,
    end,
    text: texts.join(' '),
    words: texts,
    accent,
    size: chars <= 14 ? 84 : chars <= 24 ? 72 : 62,
  };
}

function parseNumber(token) {
  const match = /^([$€]?)(\d[\d.,]*)(%?)/.exec(strip(token));
  if (!match) return null;
  let digits = match[2].replace(/[.,]+$/, '');
  // En español el punto agrupa miles ("1.500") y la coma es decimal ("2,5").
  if (/^\d{1,3}(\.\d{3})+$/.test(digits)) digits = digits.replaceAll('.', '');
  else if (/^\d{1,3}(,\d{3})+$/.test(digits)) digits = digits.replaceAll(',', '');
  else digits = digits.replace(',', '.');
  const value = Number(digits);
  if (!Number.isFinite(value) || value <= 0 || value > 1e9) return null;
  const decimals = digits.includes('.') ? Math.min(2, digits.split('.')[1].length) : 0;
  return { value, decimals, prefix: match[1], suffix: match[3] };
}

function planStats(words) {
  const stats = [];
  words.forEach((word, i) => {
    const number = parseNumber(word.text);
    if (!number) return;
    // Un año no es una cifra que contar.
    if (!number.prefix && !number.suffix && number.decimals === 0 && number.value >= 1900 && number.value <= 2099) return;
    let next = i + 1;
    if (!endsPhrase(word.text)) {
      if (bare(words[next]?.text ?? '') === 'por' && bare(words[next + 1]?.text ?? '') === 'ciento') {
        number.suffix = '%';
        next += 2;
      } else if (bare(words[next]?.text ?? '') === 'mil') {
        number.value *= 1000;
        next += 1;
      } else if (/^mill[oó]n(es)?$/.test(bare(words[next]?.text ?? ''))) {
        number.suffix = ' M';
        next += 1;
      }
    }
    // Etiqueta: las palabras que siguen a la cifra, hasta el fin de la frase.
    const label = [];
    if (!endsPhrase(word.text)) {
      for (let j = next; j < words.length && label.length < 3; j++) {
        if (/\d/.test(words[j].text)) break;
        label.push(strip(words[j].text));
        if (endsPhrase(words[j].text)) break;
      }
    }
    // Una etiqueta que acaba en preposición o artículo queda coja.
    const filler = /^(de|del|la|el|los|las|un|una|y|o|a|en|que|con|por|para|the|of|a|an|and|to|in)$/i;
    while (label.length && filler.test(label[label.length - 1])) label.pop();
    // Y si lo que sigue a la cifra no es un sustantivo ("10 de…"), la tarjeta no se entiende.
    if (!label.length || filler.test(label[0])) return;
    stats.push({
      type: 'stat-counter',
      start: Math.max(0, word.start - 0.1),
      end: word.start - 0.1 + STAT_SEC,
      priority: 3,
      ...number,
      label: label.join(' '),
    });
  });
  return stats;
}

function planBadges(words) {
  const badges = [];
  words.forEach((word, i) => {
    const token = bare(word.text);
    const text = strip(word.text);
    if (token.length < 4 || text.length > 16 || /\d/.test(text)) return;
    const sentenceStart = i === 0 || /[.!?…]$/.test(words[i - 1].text);
    const properNoun = !sentenceStart && /^\p{Lu}\p{Ll}{3,}/u.test(text);
    const priority = POWER.has(token) && !BADGE_SKIP.has(token) ? 2 : properNoun ? 1.5 : token.length >= 11 ? 1 : 0;
    if (!priority) return;
    badges.push({
      type: 'keyword-badge',
      start: Math.max(0, word.start - 0.05),
      end: word.start - 0.05 + BADGE_SEC,
      priority,
      text,
      size: text.length <= 9 ? 76 : text.length <= 12 ? 64 : 54,
    });
  });
  return badges;
}

/** Overlays del clip, ordenados por tiempo y sin solaparse. */
export function planOverlays({ words, durationSec }) {
  const title = planTitle(words, durationSec);
  const picked = title ? [title] : [];
  const budget = Math.min(7, Math.floor(durationSec / 7) + 1);
  const seen = new Set();
  const candidates = [...planStats(words), ...planBadges(words)]
    .filter((c) => c.end <= durationSec - 0.4)
    .sort((a, b) => b.priority - a.priority || a.start - b.start);
  for (const candidate of candidates) {
    if (picked.length >= budget + (title ? 1 : 0)) break;
    const key = candidate.type === 'keyword-badge' ? bare(candidate.text) : `${candidate.value}${candidate.label}`;
    if (seen.has(key)) continue;
    if (picked.some((p) => candidate.start < p.end + GAP && p.start < candidate.end + GAP)) continue;
    seen.add(key);
    picked.push(candidate);
  }
  picked.sort((a, b) => a.start - b.start);

  const timed = picked.map(({ priority, ...overlay }, i) => ({
    id: `ov-${String(i + 1).padStart(2, '0')}-${overlay.type}`,
    ...overlay,
    start: snap(overlay.start),
    end: snap(overlay.end),
    track: 3,
  }));
  return [
    { id: 'ov-00-progress-bar', type: 'progress-bar', start: 0, end: durationSec, track: 2 },
    ...timed,
  ];
}

const fill = (template, tokens) =>
  Object.entries(tokens).reduce((html, [key, value]) => html.replaceAll(`{{${key}}}`, () => String(value)), template);

function renderOverlay(overlay) {
  const template = readFileSync(path.join(ROOT, 'src', 'template', 'compositions', `${overlay.type}.html`), 'utf8');
  const duration = Number((overlay.end - overlay.start).toFixed(4));
  const common = { ID: overlay.id, DURATION: duration, BAND_TOP: OVERLAY_BAND.top, BAND_HEIGHT: OVERLAY_BAND.height };
  switch (overlay.type) {
    case 'kinetic-title':
      return fill(template, {
        ...common,
        WORD_COUNT: overlay.words.length,
        SIZE: overlay.size,
        WORDS_HTML: overlay.words
          .map((w, i) => `<span class="${overlay.id}-word${i === overlay.accent ? ' is-accent' : ''}" id="${overlay.id}-w${i}">${escapeHtml(w)}</span>`)
          .join('\n            '),
      });
    case 'stat-counter':
      return fill(template, {
        ...common,
        VALUE: overlay.value,
        VALUE_TEXT: overlay.value.toLocaleString('es', { minimumFractionDigits: overlay.decimals, maximumFractionDigits: overlay.decimals }),
        DECIMALS: overlay.decimals,
        PREFIX: overlay.prefix,
        SUFFIX: overlay.suffix,
        LABEL: escapeHtml(overlay.label),
      });
    case 'keyword-badge':
      return fill(template, { ...common, TEXT: escapeHtml(overlay.text), SIZE: overlay.size });
    default:
      return fill(template, common);
  }
}

/**
 * Planifica los overlays y escribe compositions/<id>.html y overlays.json.
 * @param {{ projectDir: string, words: Array<{text, start, end}>, durationSec: number, options?: object }} input
 *   `words` con tiempos relativos al inicio del clip.
 */
export function buildOverlays({ projectDir, words, durationSec, options = {} }, { log = () => {} } = {}) {
  const overlays = options.overlays === false ? [] : planOverlays({ words, durationSec });
  for (const overlay of overlays) {
    writeFileSync(path.join(projectDir, 'compositions', `${overlay.id}.html`), renderOverlay(overlay));
    const what = overlay.text ?? (overlay.value !== undefined ? `${overlay.prefix}${overlay.value}${overlay.suffix} ${overlay.label}` : 'todo el clip');
    log('info', `${overlay.type} @ ${overlay.start.toFixed(2)}–${overlay.end.toFixed(2)} s · ${what}`);
  }
  writeFileSync(path.join(projectDir, 'overlays.json'), `${JSON.stringify(overlays, null, 2)}\n`);
  return {
    count: overlays.length,
    band: { y0: OVERLAY_BAND.top, y1: OVERLAY_BAND.top + OVERLAY_BAND.height },
    overlays: overlays.map(({ id, type, start, end, text, value, label, prefix = '', suffix = '' }) => ({
      id,
      type,
      atSec: start,
      durationSec: Number((end - start).toFixed(2)),
      ...(text ? { text } : {}),
      ...(value !== undefined ? { value: `${prefix}${value}${suffix}`, label } : {}),
    })),
  };
}
