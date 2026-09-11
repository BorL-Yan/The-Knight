import fieldConfigJson from '../data/field_config.json';
import enemiesJson from '../data/enemies.json';
import enemyNamesJson from '../data/enemy_names.json';

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

export type EnemyTier = 'regular' | 'elite' | 'miniboss' | 'boss';

export interface EnemyCatalogEntry {
  id: string;
  name: string;
  emoji: string;
  texture: string;
  /** Ключ map-спрайта (public/assets/characters/maps/<key>.png). Фолбэк = texture. */
  mapTexture: string;
  tier: EnemyTier;
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

/** Отдельная точка для уникальных имён: src/data/enemy_names.json. */
const ENEMY_NAMES = (enemyNamesJson ?? {}) as Record<string, unknown>;

/** Миграция старых сейвов: enemy_1/2/boss -> новые id колоды. */
const LEGACY_ID_ALIASES: Record<string, string> = {
  enemy_1: 'enemy_moth',
  enemy_2: 'enemy_gator',
  enemy_boss: 'boss_hollow',
};

export function resolveEnemyName(id: string, fallbackName?: string): string {
  const v = ENEMY_NAMES[id];
  if (typeof v === 'string' && v.trim().length > 0 && !v.startsWith('TODO:')) return v;
  if (fallbackName && fallbackName.trim().length > 0 && !fallbackName.startsWith('TODO:')) return fallbackName;
  // Последний шанс: читаемое имя из enemy_names даже с TODO-префиксом без него.
  if (typeof v === 'string' && v.startsWith('TODO:')) return id;
  return fallbackName && fallbackName.length > 0 ? fallbackName : id;
}

function parseTier(v: unknown): EnemyTier {
  return v === 'regular' || v === 'elite' || v === 'miniboss' || v === 'boss' ? v : 'regular';
}

function loadEnemyCatalog(raw: unknown): EnemyCatalogEntry[] {
  const fallback: EnemyCatalogEntry[] = [
    { id: 'enemy_moth', name: 'enemy_moth', emoji: '🦋', texture: 'enemy_moth', mapTexture: 'enemy_moth', tier: 'regular', maxHp: 55, damage: 7, attackIntervalMs: 850, strikesPerTurn: 1, attackType: 'slash', damageGrowth: 1, spawnWeight: 0.28, moveChance: 0.9, coins: 12 },
    { id: 'enemy_gator', name: 'enemy_gator', emoji: '🐊', texture: 'enemy_gator', mapTexture: 'enemy_gator', tier: 'regular', maxHp: 75, damage: 9, attackIntervalMs: 750, strikesPerTurn: 1, attackType: 'slash', damageGrowth: 1, spawnWeight: 0.22, moveChance: 0.7, coins: 18 },
    { id: 'boss_hollow', name: 'boss_hollow', emoji: '🌳', texture: 'boss_hollow', mapTexture: 'boss_hollow', tier: 'boss', maxHp: 320, damage: 20, attackIntervalMs: 600, strikesPerTurn: 4, attackType: 'crush', damageGrowth: 4, spawnWeight: 0, moveChance: 0.15, coins: 150 },
  ];
  if (!Array.isArray(raw) || raw.length === 0) return fallback;
  const out: EnemyCatalogEntry[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    if (typeof o['id'] !== 'string' || (o['id'] as string).length === 0) continue;
    const maxHp = INT(o['maxHp'], 60, 1, 9999);
    const id = o['id'] as string;
    const rawName = typeof o['name'] === 'string' ? (o['name'] as string) : id;
    const texture = typeof o['texture'] === 'string' ? (o['texture'] as string) : id;
    out.push({
      id,
      name: resolveEnemyName(id, rawName),
      emoji: typeof o['emoji'] === 'string' ? (o['emoji'] as string) : '💀',
      texture,
      mapTexture: typeof o['mapTexture'] === 'string' ? (o['mapTexture'] as string) : texture,
      tier: parseTier(o['tier']),
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

/** Нормализация id: старые сейвы enemy_1/2/boss -> новые id колоды. */
export function normalizeEnemyId(id: string): string {
  return LEGACY_ID_ALIASES[id] ?? id;
}

export function enemyById(id: string): EnemyCatalogEntry | undefined {
  const norm = normalizeEnemyId(id);
  return ENEMY_CATALOG.find((e) => e.id === norm);
}

/** Слабейший regular по maxHp — наблюдатель-преследователь (первый слот). */
export function weakestEnemy(): EnemyCatalogEntry {
  const regulars = ENEMY_CATALOG.filter((e) => e.tier === 'regular');
  const source = regulars.length > 0 ? regulars : ENEMY_CATALOG;
  return [...source].sort((a, b) => a.maxHp - b.maxHp)[0] ?? ENEMY_CATALOG[0];
}

export function moveChanceById(id: string): number {
  return enemyById(normalizeEnemyId(id))?.moveChance ?? 0.5;
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
 * Слот 0 всегда слабейший regular (наблюдатель гарантирован),
 * остальные — взвешенный ролл по spawnWeight (tier boss исключён).
 */
export function pickEnemyIds(count: number, rand: () => number = Math.random): string[] {
  const n = Math.max(1, Math.min(8, Math.round(count)));
  const weak = weakestEnemy().id;
  if (n === 1) return [weak];
  const pool = ENEMY_CATALOG.filter((e) => e.spawnWeight > 0 && e.tier !== 'boss');
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
