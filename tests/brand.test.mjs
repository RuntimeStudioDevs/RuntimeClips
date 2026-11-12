// Test unitario para verificar Brand Kits y cálculo de contraste WCAG.
import { loadBrand, listBrands, contrast, brandCss } from '../src/pipeline/brand.mjs';

console.log('🧪 Iniciando prueba de Brand Kits...\n');

const brands = listBrands();
console.log('Marcas disponibles:', brands);

const brandDefault = loadBrand('default');
console.log('✔ Marca default cargada:', brandDefault.name, brandDefault.handle);

const brandNeon = loadBrand('neon');
console.log('✔ Marca neon cargada:', brandNeon.name, brandNeon.handle, brandNeon.palette.accent);

// Probar cálculo de contraste WCAG
const crHigh = contrast('#ffffff', '#000000');
console.log(`✔ Contraste Blanco sobre Negro: ${crHigh.toFixed(2)}:1 (Esperado ~21:1)`);

const crAccent = contrast(brandNeon.palette.accent, '#0a0a14');
console.log(`✔ Contraste Neon Accent sobre Fondo: ${crAccent.toFixed(2)}:1`);

if (crHigh < 15) {
  console.error('❌ FALLÓ: El contraste calculado no es el esperado');
  process.exit(1);
}

const css = brandCss(brandNeon);
if (!css.includes('--accent: #00f0ff')) {
  console.error('❌ FALLÓ: El CSS de la marca no incluye el color acento');
  process.exit(1);
}

console.log('\n🎉 ¡Todos los tests de Brand Kits pasaron exitosamente!');
