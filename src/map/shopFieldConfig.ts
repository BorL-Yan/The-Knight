import shopFieldJson from '../data/shop_field.json';

/**
 * Конфиг поля комнаты-магазина (src/data/shop_field.json).
 * Ровно одна комната-магазин на данж строится по этим параметрам:
 * маленькое поле, по умолчанию без врагов (мирный магазин).
 * Всё с валидацией и безопасными фолбэками, чтобы битый JSON не ронял игру.
 */

export interface ShopFieldConfig {
  cols: number;
  rows: number;
  enemyCount: number;
  maxGrassMin: number;
  maxGrassSpan: number;
}

const NUM = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const INT = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = NUM(v, fallback);
  return Math.min(max, Math.max(min, Math.round(n)));
};

function loadShopFieldConfig(raw: unknown): ShopFieldConfig {
  const d = (raw ?? {}) as Record<string, unknown>;
  return {
    cols: INT(d['cols'], 4, 3, 12),
    rows: INT(d['rows'], 6, 3, 12),
    enemyCount: INT(d['enemyCount'], 0, 0, 3),
    maxGrassMin: INT(d['maxGrassMin'], 8, 4, 60),
    maxGrassSpan: INT(d['maxGrassSpan'], 4, 0, 30),
  };
}

export const SHOP_FIELD: ShopFieldConfig = loadShopFieldConfig(shopFieldJson);
