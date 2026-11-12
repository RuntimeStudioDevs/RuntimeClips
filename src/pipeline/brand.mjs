// RuntimeClips — Gestión de Brand Kits (marcas personalizadas).
// Permite personalizar la paleta de colores, tipografía, marca de agua y subtítulos.
// Calcula contraste WCAG para asegurar que el texto sea siempre legible sobre el video.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './tools.mjs';

const HEX = /^#[0-9a-fA-F]{6}$/;

const DEFAULT_BRAND = {
  name: 'default',
  handle: '@runtimeclips',
  palette: {
    bg: '#0d0e12',
    ink: '#ffffff',
    accent: '#ff6d5a',
    accent2: '#ffe600',
    card: 'rgba(21, 23, 29, 0.85)',
  },
  fonts: {
    display: 'Inter',
    body: 'Inter',
  },
  captions: {
    size: 72,
    case: 'upper',
    highlight: 'accent2', // color que ilumina la palabra activa
    box: 'rgba(0, 0, 0, 0.75)', // fondo de alto contraste
  },
};

export function listBrands() {
  const dir = path.join(ROOT, 'brands');
  if (!existsSync(dir)) return ['default'];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

export function loadBrand(name = 'default') {
  if (!name || name === 'default') return DEFAULT_BRAND;
  const file = path.join(ROOT, 'brands', `${name}.json`);
  if (!existsSync(file)) {
    return DEFAULT_BRAND;
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return {
      ...DEFAULT_BRAND,
      ...raw,
      palette: { ...DEFAULT_BRAND.palette, ...(raw.palette || {}) },
      fonts: { ...DEFAULT_BRAND.fonts, ...(raw.fonts || {}) },
      captions: { ...DEFAULT_BRAND.captions, ...(raw.captions || {}) },
      name,
    };
  } catch {
    return DEFAULT_BRAND;
  }
}

function luminance(hex) {
  if (!hex || !HEX.test(hex)) return 0.5;
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Ratio de contraste WCAG entre dos colores hex (mínimo 4.5:1 para texto normal, 3:1 para títulos). */
export function contrast(hexA, hexB) {
  const [hi, lo] = [luminance(hexA), luminance(hexB)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function brandCss(brand) {
  const p = brand.palette;
  const cap = brand.captions;
  const highlightColor = p[cap.highlight] || cap.highlight || p.accent2 || '#ffe600';
  return `
    :root {
      --bg: ${p.bg};
      --ink: ${p.ink};
      --accent: ${p.accent};
      --accent2: ${p.accent2 || p.accent};
      --card-bg: ${p.card};
      --cap-ink: ${p.ink};
      --cap-highlight: ${highlightColor};
      --cap-box: ${cap.box};
      --font-display: "${brand.fonts.display}", ui-sans-serif, system-ui, sans-serif;
      --font-body: "${brand.fonts.body}", ui-sans-serif, system-ui, sans-serif;
    }
  `.trim();
}
