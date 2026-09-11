import fieldConfigJson from '../data/field_config.json';
import enemiesJson from '../data/enemies.json';

/**
 * Единая точка чтения конфигов поля и врагов.
 * - field_config.json: размеры поля в ячейках, размер ячейки, число врагов.
 * - enemies.json: attackType / damageGrowth / spawnWeight / moveChance.
 * Всё с валидацией и безопасными фолбэками, чтобы битый JSON не ронял игру.
 */

export interface FieldConfig {
  cols: number;
  rows: number;
  cellSizePx: number;
  minCellPx: number;
  topReservePx: number;
  bottomReservePx: number;
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

function loadFieldConfig(raw: unknown): FieldConfig {
  const d = (raw ?? {}) as Record<string, unknown>;
  return {
    cols: INT(d['cols'], 11, 3, 30),
    rows: INT(d['rows'], 14, 3, 30),
    cellSizePx: INT(d['cellSizePx'], 40, 16, 96),
    minCellPx: INT(d['minCellPx'], 20, 10, 48),
    topReservePx: INT(d['topReservePx'], 108, 0, 400),
    bottomReservePx: INT(d['bottomReservePx'], 210, 0, 500),
    enemyCount: INT(d['enemyCount'], 3, 1, 8),
    maxGrassMin: INT(d['maxGrassMin'], 44, 4, 400),
    maxGrassSpan: INT(d['maxGrassSpan'], 10, 0, 100),
  };
}

export const FIELD_CONFIG: FieldConfig = loadFieldConfig(fieldConfigJson);

export interface EnemyCatalogEntry {
  id: string;
  name: string;
  emoji: string;
  texture: string;
  maxHp: number;
  damage: number;
  attackIntervalMs: number;
  strikesPerTurn: number;
  /** Тип атаки: slash / double / crush (расширяемо). */
  attackType: string;
  /** На сколько растёт сила атаки за каждое следующее поле. */
  damageGrowth: number;
  /** Вес при выборе типа для заселения поля (сумма нормализуется). */
  spawnWeight: number;
  /** Шанс хода после хода игрока (0..1): слабее => выше. */
  moveChance: number;
  /** Деньги за уничтожение (уходят в кошелёк забега для магазина). */
  coins: number;
}

function loadEnemyCatalog(raw: unknown): EnemyCatalogEntry[] {
  const fallback: EnemyCatalogEntry[] = [
    { id: 'enemy_1', name: 'Enemy_1', emoji: '🟢', texture: 'enemy_1', maxHp: 60, damage: 8, attackIntervalMs: 800, strikesPerTurn: 1, attackType: 'slash', damageGrowth: 1, spawnWeight: 0.5, moveChance: 0.9, coins: 15 },
    { id: 'enemy_2', name: 'Enemy_2', emoji: '👹', texture: 'enemy_2', maxHp: 90, damage: 10, attackIntervalMs: 700, strikesPerTurn: 2, attackType: 'double', damageGrowth: 2, spawnWeight: 0.35, moveChance: 0.5, coins: 30 },
    { id: 'enemy_boss', name: 'Enemy_Boss', emoji: '🗿', texture: 'enemy_boss', maxHp: 130, damage: 12, attackIntervalMs: 650, strikesPerTurn: 3, attackType: 'crush', damageGrowth: 3, spawnWeight: 0.15, moveChance: 0.2, coins: 60 },
  ];
  if (!Array.isArray(raw) || raw.length === 0) return fallback;
  const out: EnemyCatalogEntry[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    if (typeof o['id'] !== 'string' || (o['id'] as string).length === 0) continue;
    const maxHp = INT(o['maxHp'], 60, 1, 9999);
    out.push({
      id: o['id'] as string,
      name: typeof o['name'] === 'string' ? (o['name'] as string) : (o['id'] as string),
      emoji: typeof o['emoji'] === 'string' ? (o['emoji'] as string) : '💀',
      texture: typeof o['texture'] === 'string' ? (o['texture'] as string) : (o['id'] as string),
      maxHp,
      damage: INT(o['damage'], 8, 0, 999),
      attackIntervalMs: INT(o['attackIntervalMs'], 700, 50, 10000),
      strikesPerTurn: INT(o['strikesPerTurn'], 1, 1, 9),
      attackType: typeof o['attackType'] === 'string' ? (o['attackType'] as string) : 'slash',
      damageGrowth: NUM(o['damageGrowth'], 1),
      spawnWeight: Math.max(0, NUM(o['spawnWeight'], 1)),
      moveChance: Math.min(1, Math.max(0, NUM(o['moveChance'], 0.5))),
      coins: INT(o['coins'], 15, 0, 9999),
    });
  }
  return out.length > 0 ? out : fallback;
}

export const ENEMY_CATALOG: EnemyCatalogEntry[] = loadEnemyCatalog(enemiesJson);

export function enemyById(id: string): EnemyCatalogEntry | undefined {
  return ENEMY_CATALOG.find((e) => e.id === id);
}

/** Слабейший по maxHp — наблюдатель-преследователь (первый слот). */
export function weakestEnemy(): EnemyCatalogEntry {
  return [...ENEMY_CATALOG].sort((a, b) => a.maxHp - b.maxHp)[0] ?? ENEMY_CATALOG[0];
}

export function moveChanceById(id: string): number {
  return enemyById(id)?.moveChance ?? 0.5;
}

export function moveChances(): Record<string, number> {
  return Object.fromEntries(ENEMY_CATALOG.map((e) => [e.id, e.moveChance]));
}

/** Урон с учётом глубины забега: база + growth за каждое поле после первого. */
export function scaledDamage(entry: EnemyCatalogEntry, fieldNum: number): number {
  const growth = Number.isFinite(entry.damageGrowth) ? entry.damageGrowth : 0;
  return Math.max(0, Math.round(entry.damage + growth * Math.max(0, fieldNum - 1)));
}

/** Деньги за убийство: из каталога, при битой записи — из shop_config через фолбэк. */
export function coinsFor(entry: EnemyCatalogEntry | undefined, fallbackById?: (id: string) => number): number {
  if (entry && Number.isFinite(entry.coins)) return Math.max(0, Math.round(entry.coins));
  if (entry && fallbackById) return fallbackById(entry.id);
  return 15;
}

/**
 * Какие типы поставить на поле (длина = count).
 * Слот 0 всегда слабейший (наблюдатель гарантирован),
 * остальные — взвешенный ролл по spawnWeight.
 */
export function pickEnemyIds(count: number, rand: () => number = Math.random): string[] {
  const n = Math.max(1, Math.min(8, Math.round(count)));
  const weak = weakestEnemy().id;
  if (n === 1) return [weak];
  const pool = ENEMY_CATALOG.filter((e) => e.spawnWeight > 0);
  const source = pool.length > 0 ? pool : ENEMY_CATALOG;
  const total = source.reduce((s, e) => s + e.spawnWeight, 0) || 1;
  const ids: string[] = [weak];
  for (let i = 1; i < n; i++) {
    let r = rand() * total;
    let pick = source[source.length - 1].id;
    for (const e of source) {
      r -= e.spawnWeight;
      if (r <= 0) {
        pick = e.id;
        break;
      }
    }
    ids.push(pick);
  }
  return ids;
}
