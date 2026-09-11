/**
 * Конфиг анимации появления поля (src/data/reveal_config.json).
 * - totalMs: полное время эффекта, fadeMs: проявление одной клетки;
 * - dropPx: высота в px, с которой клетки опускаются (0 — без падения);
 * - dropEase: easing падения; waveFrom: 'entry' — волна от стороны входа,
 *   'center' — всегда от центра.
 */

export interface RevealConfig {
  totalMs: number;
  fadeMs: number;
  dropPx: number;
  dropEase: string;
  waveFrom: 'entry' | 'center';
}

export const DEFAULT_REVEAL: RevealConfig = {
  totalMs: 2000,
  fadeMs: 600,
  dropPx: 64,
  dropEase: 'Cubic.easeOut',
  waveFrom: 'entry',
};

const ALLOWED_EASES = new Set([
  'Linear',
  'Quad.easeIn',
  'Quad.easeOut',
  'Cubic.easeOut',
  'Bounce.easeOut',
  'Back.easeOut',
]);

/** Разбор с клампами; битый/пустой JSON → безопасные значения по умолчанию. */
export function parseRevealConfig(input: unknown): RevealConfig {
  const cfg: RevealConfig = { ...DEFAULT_REVEAL };
  if (typeof input !== 'object' || input === null) return cfg;
  const d = input as Record<string, unknown>;
  if (typeof d['totalMs'] === 'number' && Number.isFinite(d['totalMs'])) {
    cfg.totalMs = Math.min(5000, Math.max(300, d['totalMs']));
  }
  if (typeof d['fadeMs'] === 'number' && Number.isFinite(d['fadeMs'])) {
    cfg.fadeMs = Math.min(cfg.totalMs, Math.max(100, d['fadeMs']));
  }
  if (typeof d['dropPx'] === 'number' && Number.isFinite(d['dropPx'])) {
    cfg.dropPx = Math.min(600, Math.max(0, d['dropPx']));
  }
  if (typeof d['dropEase'] === 'string' && ALLOWED_EASES.has(d['dropEase'])) {
    cfg.dropEase = d['dropEase'];
  }
  if (d['waveFrom'] === 'center' || d['waveFrom'] === 'entry') {
    cfg.waveFrom = d['waveFrom'];
  }
  return cfg;
}
