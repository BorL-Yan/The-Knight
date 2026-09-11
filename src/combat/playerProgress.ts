import type { ComboData } from './types';
import shopConfigJson from '../data/shop_config.json';

/**
 * Прогресс игрока для магазина торговца:
 * - coins: деньги за уничтожение противников;
 * - owned: id способностей, доступных в бою;
 * - stars: id -> 0..maxStars (каждая звезда +powerPerStar к power).
 *
 * Изначально доступна только часть способностей (startOwned),
 * остальные покупаются во 2-м ряду магазина.
 * Первый ряд магазина — улучшение owned (до maxStars).
 */

export interface ShopConfig {
  startOwned: string[];
  maxStars: number;
  powerPerStar: number;
  upgradeCosts: number[];
  buyCosts: Record<string, number>;
  rerollCost: number;
  startCoins: number;
  coinRewards: Record<string, number>;
}

function num(v: unknown, fb: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fb;
}

function loadShopConfig(raw: unknown): ShopConfig {
  const d = (raw ?? {}) as Record<string, unknown>;
  const startOwned = Array.isArray(d['startOwned'])
    ? (d['startOwned'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : ['fire', 'ice', 'heal'];
  const buyRaw = (d['buyCosts'] ?? {}) as Record<string, unknown>;
  const buyCosts: Record<string, number> = {};
  for (const [k, v] of Object.entries(buyRaw)) buyCosts[k] = Math.max(0, Math.round(num(v, 50)));
  const coinRaw = (d['coinRewards'] ?? {}) as Record<string, unknown>;
  const coinRewards: Record<string, number> = {};
  for (const [k, v] of Object.entries(coinRaw)) coinRewards[k] = Math.max(0, Math.round(num(v, 15)));
  const upRaw = d['upgradeCosts'];
  const upgradeCosts = Array.isArray(upRaw)
    ? (upRaw as unknown[]).map((v) => Math.max(0, Math.round(num(v, 50))))
    : [30, 60, 120];
  return {
    startOwned: startOwned.length > 0 ? startOwned : ['fire', 'ice', 'heal'],
    maxStars: Math.min(5, Math.max(1, Math.round(num(d['maxStars'], 3)))),
    powerPerStar: Math.min(2, Math.max(0, num(d['powerPerStar'], 0.4))),
    upgradeCosts,
    buyCosts,
    rerollCost: Math.max(0, Math.round(num(d['rerollCost'], 15))),
    startCoins: Math.max(0, Math.round(num(d['startCoins'], 0))),
    coinRewards,
  };
}

export const SHOP_CONFIG: ShopConfig = loadShopConfig(shopConfigJson);

export interface PlayerProgressData {
  coins: number;
  owned: string[];
  stars: Record<string, number>;
}

export interface ShopOffers {
  /** id из owned, которые можно улучшить (макс 3, 1-й ряд). */
  upgrades: string[];
  /** id из locked для покупки (макс 3, 2-й ряд). */
  news: string[];
}

export function defaultProgress(): PlayerProgressData {
  const stars: Record<string, number> = {};
  for (const id of SHOP_CONFIG.startOwned) stars[id] = 0;
  return { coins: SHOP_CONFIG.startCoins, owned: [...SHOP_CONFIG.startOwned], stars };
}

/** Загрузить прогресс из registry с валидацией; битый/пустой -> дефолт. */
export function loadProgress(raw: unknown): PlayerProgressData {
  const fb = defaultProgress();
  if (!raw || typeof raw !== 'object') return fb;
  const d = raw as Record<string, unknown>;
  const coins = typeof d['coins'] === 'number' && Number.isFinite(d['coins'])
    ? Math.max(0, Math.floor(d['coins'] as number))
    : fb.coins;
  const owned = Array.isArray(d['owned'])
    ? (d['owned'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : [...fb.owned];
  const starsRaw = (d['stars'] ?? {}) as Record<string, unknown>;
  const stars: Record<string, number> = {};
  for (const id of owned) {
    const v = starsRaw[id];
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0;
    stars[id] = Math.min(SHOP_CONFIG.maxStars, Math.max(0, n));
  }
  const safeOwned = owned.length > 0 ? owned : [...fb.owned];
  for (const id of safeOwned) if (!(id in stars)) stars[id] = 0;
  return { coins, owned: safeOwned, stars };
}

export function cloneProgress(p: PlayerProgressData): PlayerProgressData {
  return { coins: p.coins, owned: [...p.owned], stars: { ...p.stars } };
}

/** Уровень звёзд 0..maxStars. */
export function starLevel(p: PlayerProgressData, id: string): number {
  if (!p.owned.includes(id)) return 0;
  return Math.min(SHOP_CONFIG.maxStars, Math.max(0, p.stars[id] ?? 0));
}

/** Маленькие жёлтые звёздочки под способностью: ★ = улучшение, ☆ = пусто. */
export function starsText(level: number, max: number = SHOP_CONFIG.maxStars): string {
  const l = Math.min(max, Math.max(0, Math.round(level)));
  return '★'.repeat(l) + '☆'.repeat(Math.max(0, max - l));
}

/** Эффективный power с учётом звёзд: base * (1 + powerPerStar * level). */
export function effectivePower(base: number, level: number): number {
  return Math.max(1, Math.round(base * (1 + SHOP_CONFIG.powerPerStar * level)));
}

/** Только owned-комбо с пересчитанным power (для боя). */
export function effectiveCombos(all: ComboData[], p: PlayerProgressData): ComboData[] {
  const out: ComboData[] = [];
  for (const c of all) {
    if (!p.owned.includes(c.id)) continue;
    const lvl = starLevel(p, c.id);
    out.push(lvl > 0 ? { ...c, power: effectivePower(c.power, lvl) } : { ...c });
  }
  // Сохраняем порядок all, но гарантируем хотя бы 1 комбо чтобы бой не сломался.
  if (out.length === 0 && all.length > 0) {
    const first = all[0];
    out.push({ ...first });
  }
  return out;
}

/** Цена улучшения id с текущего уровня (0->1 = upgradeCosts[0]). -1 если MAX. */
export function upgradeCost(id: string, level: number): number {
  if (level >= SHOP_CONFIG.maxStars) return -1;
  const arr = SHOP_CONFIG.upgradeCosts;
  if (arr.length === 0) return 50;
  return arr[Math.min(level, arr.length - 1)];
}

/** Цена покупки новой способности. */
export function buyCost(id: string): number {
  return SHOP_CONFIG.buyCosts[id] ?? 50;
}

/** Награда за убийство врага по enemyId. */
export function coinsForEnemy(enemyId: string): number {
  return SHOP_CONFIG.coinRewards[enemyId] ?? 15;
}

function sample<T>(arr: T[], n: number, rand: () => number = Math.random): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.max(0, n));
}

/**
 * Собрать предложения торговца:
 * - 1-й ряд: до 3 owned со звёздами < max (случайные);
 * - 2-й ряд: до 3 locked (случайные).
 */
export function rollShopOffers(
  all: ComboData[],
  p: PlayerProgressData,
  rand: () => number = Math.random,
): ShopOffers {
  const upgradeable = p.owned.filter((id) => starLevel(p, id) < SHOP_CONFIG.maxStars);
  const locked = all.map((c) => c.id).filter((id) => !p.owned.includes(id));
  return {
    upgrades: sample(upgradeable, 3, rand),
    news: sample(locked, 3, rand),
  };
}

/** Валидация сохранённых офферов (убрать купленное/макснутое). */
export function sanitizeOffers(all: ComboData[], p: PlayerProgressData, o: ShopOffers | null | undefined): ShopOffers {
  const ids = new Set(all.map((c) => c.id));
  if (!o || typeof o !== 'object') return rollShopOffers(all, p);
  const upgrades = (Array.isArray(o.upgrades) ? o.upgrades : [])
    .filter((id) => typeof id === 'string' && ids.has(id) && p.owned.includes(id) && starLevel(p, id) < SHOP_CONFIG.maxStars)
    .slice(0, 3);
  const news = (Array.isArray(o.news) ? o.news : [])
    .filter((id) => typeof id === 'string' && ids.has(id) && !p.owned.includes(id))
    .slice(0, 3);
  // Добиваем до 3 если есть кем (чтобы ряды не пустели после покупки).
  if (upgrades.length < 3) {
    const rest = p.owned.filter((id) => starLevel(p, id) < SHOP_CONFIG.maxStars && !upgrades.includes(id));
    upgrades.push(...sample(rest, 3 - upgrades.length));
  }
  if (news.length < 3) {
    const rest = all.map((c) => c.id).filter((id) => !p.owned.includes(id) && !news.includes(id));
    news.push(...sample(rest, 3 - news.length));
  }
  return { upgrades, news };
}
