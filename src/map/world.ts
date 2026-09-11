import type { SwipeDir } from '../combat/types';

/**
 * Генератор мира-лабиринта 11×14.
 * - Граница поля засажена лесом, ровно по одному выходу на сторону;
 * - от каждого выхода тропы (жадные блуждатели) расходятся к центру;
 * - достигнутые клетки активны (трава), недостигнутые — лес или вода;
 * - спавн в центре, связность выходов гарантирована ремонтом коридоров.
 */

export const WORLD_COLS = 11;
export const WORLD_ROWS = 14;

export type Terrain = 'void' | 'grass' | 'water' | 'forest';
export type Decor = 'none' | 'stump' | 'flowers' | 'reeds' | 'rock';
export type ExitDir = 'N' | 'S' | 'E' | 'W';

export interface WorldPos {
  col: number;
  row: number;
}

export interface WorldCell {
  terrain: Terrain;
  decor: Decor;
  exit?: ExitDir;
}

export interface World {
  cols: number;
  rows: number;
  /** cells[row][col] */
  cells: WorldCell[][];
  spawn: WorldPos;
  enemies: WorldPos[];
  /**
   * Двери поля. Ключи = только связанные стороны графа:
   * комната с соседями сверху/справа имеет лишь { N, E }.
   * Глухих выходов нет — граница без двери всегда лес.
   */
  exits: Partial<Record<ExitDir, WorldPos>>;
  /** Клетка торговца 🏪: всегда трава, сюда встаёт игрок чтобы открыть магазин. */
  merchant: WorldPos;
}

/** Все 4 стороны — дефолт когда набор дверей не задан (legacy/тесты). */
export const ALL_EXIT_DIRS: readonly ExitDir[] = ['N', 'S', 'E', 'W'];

export interface GenerateWorldOptions {
  seed?: number;
  /** Переопределяют WORLD_COLS/ROWS (берутся из field_config.json сценой). */
  cols?: number;
  rows?: number;
  /** Сколько врагов создать (по умолчанию 2, конфиг сейчас просит 3). */
  enemyCount?: number;
  /** База и разброс числа травяных клеток (по умолчанию 44 + 0..9). */
  maxGrassMin?: number;
  maxGrassSpan?: number;
  /**
   * На каких сторонах прорубить двери. Обычно = linkedDirs() узла графа:
   * двери ровно туда, где есть соседи. Пусто/нет поля — все 4 (как раньше).
   */
  exits?: ExitDir[];
}

/** Нормализация запрошенных дверей: валидные, уникальные, минимум 1. */
export function normalizeExitDirs(sides: ExitDir[] | undefined): ExitDir[] {
  const seen = new Set<ExitDir>();
  for (const d of sides ?? []) {
    if (d === 'N' || d === 'S' || d === 'E' || d === 'W') seen.add(d);
  }
  if (seen.size === 0) return [...ALL_EXIT_DIRS];
  return [...ALL_EXIT_DIRS].filter((d) => seen.has(d));
}

/** Позиции существующих дверей (порядок N,S,E,W). */
export function exitPositions(exits: Partial<Record<ExitDir, WorldPos>>): WorldPos[] {
  const out: WorldPos[] = [];
  for (const d of ALL_EXIT_DIRS) {
    const p = exits[d];
    if (p) out.push(p);
  }
  return out;
}

export function isInsideWorld(world: World, p: WorldPos): boolean {
  return p.col >= 0 && p.col < world.cols && p.row >= 0 && p.row < world.rows;
}

/** Ходибельна только трава. Вода/лес/пустота — нет. */
export function isWalkable(world: World, p: WorldPos): boolean {
  if (!isInsideWorld(world, p)) return false;
  return world.cells[p.row][p.col].terrain === 'grass';
}

function dirDelta(dir: SwipeDir): WorldPos {
  switch (dir) {
    case 'Up':
      return { col: 0, row: -1 };
    case 'Down':
      return { col: 0, row: 1 };
    case 'Left':
      return { col: -1, row: 0 };
    case 'Right':
      return { col: 1, row: 0 };
  }
}

export type StepBlockReason = 'ok' | 'water' | 'forest' | 'void' | 'edge';

export interface WorldStepResult {
  next: WorldPos;
  moved: boolean;
  reason: StepBlockReason;
}

/** Свайп = ровно одна клетка. */
export function tryStepWorld(world: World, from: WorldPos, dir: SwipeDir): WorldStepResult {
  const d = dirDelta(dir);
  const next: WorldPos = { col: from.col + d.col, row: from.row + d.row };
  if (!isInsideWorld(world, next)) return { next: from, moved: false, reason: 'edge' };
  const t = world.cells[next.row][next.col].terrain;
  if (t === 'grass') return { next, moved: true, reason: 'ok' };
  if (t === 'water') return { next: from, moved: false, reason: 'water' };
  if (t === 'forest') return { next: from, moved: false, reason: 'forest' };
  return { next: from, moved: false, reason: 'void' };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function posKey(p: WorldPos): string {
  return `${p.col},${p.row}`;
}

function manhattan(a: WorldPos, b: WorldPos): number {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
}

/** BFS по траве от старта. Возвращает ключи достижимых. */
export function reachableGrass(world: World, start: WorldPos): Set<string> {
  const seen = new Set<string>();
  if (!isWalkable(world, start)) return seen;
  const queue: WorldPos[] = [{ ...start }];
  seen.add(posKey(start));
  while (queue.length > 0) {
    const cur = queue.pop() as WorldPos;
    const neigh: WorldPos[] = [
      { col: cur.col + 1, row: cur.row },
      { col: cur.col - 1, row: cur.row },
      { col: cur.col, row: cur.row + 1 },
      { col: cur.col, row: cur.row - 1 },
    ];
    for (const n of neigh) {
      if (!isWalkable(world, n)) continue;
      const k = posKey(n);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push(n);
    }
  }
  return seen;
}

export function countTerrain(world: World, t: Terrain): number {
  let n = 0;
  for (const row of world.cells)
    for (const c of row) if (c.terrain === t) n++;
  return n;
}

/**
 * Требуемые выходы — трава и достижимы из спавна,
 * плюс вся трава — один компонент (без островков).
 * sides = какие двери проверять (по умолчанию — все существующие).
 */
export function exitsConnected(world: World, sides?: ExitDir[]): boolean {
  const dirs = sides ?? (Object.keys(world.exits) as ExitDir[]);
  const reach = reachableGrass(world, world.spawn);
  for (const d of dirs) {
    const e = world.exits[d];
    if (!e) return false;
    if (!isWalkable(world, e)) return false;
    if (!reach.has(posKey(e))) return false;
  }
  // Вся трава должна быть достижима из спавна.
  for (let r = 0; r < world.rows; r++) {
    for (let c = 0; c < world.cols; c++) {
      if (world.cells[r][c].terrain === 'grass' && !reach.has(posKey({ col: c, row: r }))) {
        return false;
      }
    }
  }
  // Вода ровно одна (как на картинке).
  if (countTerrain(world, 'water') !== 1) return false;
  return true;
}

/**
 * Мягкая проверка для HUD/JSON-карт: выходы на траве и достижимы,
 * вся трава — один компонент. Число вод не важно (в JSON их может быть 0+).
 */
export function worldPlayable(world: World, sides?: ExitDir[]): boolean {
  const dirs = sides ?? (Object.keys(world.exits) as ExitDir[]);
  const reach = reachableGrass(world, world.spawn);
  if (reach.size === 0) return false;
  for (const d of dirs) {
    const e = world.exits[d];
    if (!e) return false;
    if (!isWalkable(world, e)) return false;
    if (!reach.has(posKey(e))) return false;
  }
  for (let r = 0; r < world.rows; r++) {
    for (let c = 0; c < world.cols; c++) {
      if (world.cells[r][c].terrain === 'grass' && !reach.has(posKey({ col: c, row: r }))) {
        return false;
      }
    }
  }
  return true;
}

function emptyCells(cols: number, rows: number): WorldCell[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, (): WorldCell => ({ terrain: 'void', decor: 'none' })),
  );
}

/** Центр поля — сюда сходятся тропы, здесь спавн. */
function centerOf(cols: number, rows: number): WorldPos {
  return { col: Math.floor(cols / 2), row: Math.floor(rows / 2) };
}

/** Внутренняя часть (без границы). Граница всегда лес, кроме выходов. */
function inInterior(p: WorldPos, cols: number = WORLD_COLS, rows: number = WORLD_ROWS): boolean {
  return p.col >= 1 && p.col < cols - 1 && p.row >= 1 && p.row < rows - 1;
}

function orthoCells(p: WorldPos): WorldPos[] {
  return [
    { col: p.col + 1, row: p.row },
    { col: p.col - 1, row: p.row },
    { col: p.col, row: p.row + 1 },
    { col: p.col, row: p.row - 1 },
  ];
}

/** По одному выходу на каждую запрошенную сторону; граница в этих точках — трава. */
function randomExits(
  rand: () => number,
  cols: number,
  rows: number,
  sides: ExitDir[],
): Partial<Record<ExitDir, WorldPos>> {
  const col = () => 1 + Math.floor(rand() * (cols - 2));
  const row = () => 1 + Math.floor(rand() * (rows - 2));
  const exits: Partial<Record<ExitDir, WorldPos>> = {};
  if (sides.includes('N')) exits.N = { col: col(), row: 0 };
  if (sides.includes('S')) exits.S = { col: col(), row: rows - 1 };
  if (sides.includes('W')) exits.W = { col: 0, row: row() };
  if (sides.includes('E')) exits.E = { col: cols - 1, row: row() };
  return exits;
}

/**
 * Тропы лабиринта: от каждого требуемого выхода по 2 блуждателя к центру.
 * Шаг на 60% жадный (ближе к центру), иначе случайный — получаются
 * ветвистые коридоры. Ходить можно только по interior, граница
 * (кроме выходов) остаётся лесом.
 */
function carveWalks(
  active: Set<string>,
  exits: Partial<Record<ExitDir, WorldPos>>,
  rand: () => number,
  maxActive: number,
  center: WorldPos,
  cols: number,
  rows: number,
): void {
  const starts = exitPositions(exits);
  for (const start of starts) {
    for (let w = 0; w < 2; w++) {
      if (active.size >= maxActive) return;
      let pos = { ...start };
      let guard = 0;
      while (guard++ < 26 && active.size < maxActive) {
        if (Math.abs(pos.col - center.col) <= 1 && Math.abs(pos.row - center.row) <= 1) break;
        const cands = orthoCells(pos).filter((p) => inInterior(p, cols, rows));
        if (cands.length === 0) break;
        let next: WorldPos;
        if (rand() < 0.6) {
          let best = Infinity;
          let pool: WorldPos[] = [];
          for (const c of cands) {
            const d = manhattan(c, center);
            if (d < best) {
              best = d;
              pool = [c];
            } else if (d === best) {
              pool.push(c);
            }
          }
          next = pool[Math.floor(rand() * pool.length)];
        } else {
          next = cands[Math.floor(rand() * cands.length)];
        }
        pos = next;
        active.add(posKey(pos));
      }
    }
  }
}

/** BFS по множеству активных клеток от старта. */
function setReachable(active: Set<string>, start: WorldPos): Set<string> {
  const seen = new Set<string>();
  const sk = posKey(start);
  if (!active.has(sk)) return seen;
  const queue: WorldPos[] = [{ ...start }];
  seen.add(sk);
  while (queue.length > 0) {
    const cur = queue.pop() as WorldPos;
    for (const n of orthoCells(cur)) {
      const k = posKey(n);
      if (!active.has(k) || seen.has(k)) continue;
      seen.add(k);
      queue.push(n);
    }
  }
  return seen;
}

/**
 * Прямой коридор выход → центр. Для N/S сначала по вертикали,
 * для W/E сначала по горизонтали — коридор не задевает границу.
 */
function carveExitToCenter(
  active: Set<string>,
  exit: WorldPos,
  vertical: boolean,
  center: WorldPos,
): void {
  let c = exit.col;
  let r = exit.row;
  if (vertical) {
    while (r !== center.row) {
      r += Math.sign(center.row - r);
      active.add(posKey({ col: c, row: r }));
    }
    while (c !== center.col) {
      c += Math.sign(center.col - c);
      active.add(posKey({ col: c, row: r }));
    }
  } else {
    while (c !== center.col) {
      c += Math.sign(center.col - c);
      active.add(posKey({ col: c, row: r }));
    }
    while (r !== center.row) {
      r += Math.sign(center.row - r);
      active.add(posKey({ col: c, row: r }));
    }
  }
}

function clampInt(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

export function generateWorld(opts: GenerateWorldOptions = {}): World {
  const seed = opts.seed ?? 12345;
  const rand = mulberry32(seed);
  const cols = clampInt(opts.cols ?? WORLD_COLS, 3, 30, WORLD_COLS);
  const rows = clampInt(opts.rows ?? WORLD_ROWS, 3, 30, WORLD_ROWS);
  const center = centerOf(cols, rows);
  const sides = normalizeExitDirs(opts.exits);
  const exits = randomExits(rand, cols, rows, sides);
  const exitKeys = new Set(exitPositions(exits).map(posKey));
  const spawn: WorldPos = { ...center };

  // --- Активные клетки: тропы от требуемых выходов к центру + ремонт связности ---
  const active = new Set<string>([...exitPositions(exits).map(posKey)]);
  const grassMin = clampInt(opts.maxGrassMin ?? 44, 4, 400, 44);
  const grassSpan = clampInt(opts.maxGrassSpan ?? 10, 0, 100, 10);
  const maxActive = grassMin + Math.floor(rand() * (grassSpan + 1));
  carveWalks(active, exits, rand, maxActive, center, cols, rows);
  // Каждый выход обязан доставать до центра — иначе прямой коридор.
  for (const [dir, p] of Object.entries(exits) as Array<[ExitDir, WorldPos]>) {
    if (!setReachable(active, p).has(posKey(spawn))) {
      carveExitToCenter(active, p, dir === 'N' || dir === 'S', center);
    }
  }

  // --- Связность уже гарантирована ремонтом коридоров выше ---

  // --- Вода: 1–2 пруда на недостигнутых клетках interior ---
  const spawnKey = posKey(spawn);
  const inactive: WorldPos[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = { col: c, row: r };
      if (!inInterior(p, cols, rows)) continue;
      if (!active.has(posKey(p))) inactive.push(p);
    }
  }
  for (let i = inactive.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [inactive[i], inactive[j]] = [inactive[j], inactive[i]];
  }
  const waterSet = new Set<string>();
  const ponds = 1 + (rand() < 0.5 ? 1 : 0);
  for (let i = 0; i < ponds && inactive.length > 0; i++) {
    const s = inactive.pop() as WorldPos;
    waterSet.add(posKey(s));
    const extra = Math.floor(rand() * 3); // 0–2 соседние клетки пруда
    const ns = orthoCells(s).filter(
      (p) => inInterior(p, cols, rows) && !active.has(posKey(p)) && !waterSet.has(posKey(p)),
    );
    for (let k = ns.length - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      [ns[k], ns[j]] = [ns[j], ns[k]];
    }
    for (let k = 0; k < Math.min(extra, ns.length); k++) waterSet.add(posKey(ns[k]));
  }
  if (waterSet.size === 0 && inactive.length > 0) {
    waterSet.add(posKey(inactive[0]));
  }

  // --- Сборка: граница — лес, active — трава, остальное — лес/вода ---
  const cells = emptyCells(cols, rows);
  for (let c = 0; c < cols; c++) {
    cells[0][c] = { terrain: 'forest', decor: 'none' };
    cells[rows - 1][c] = { terrain: 'forest', decor: 'none' };
  }
  for (let r = 0; r < rows; r++) {
    cells[r][0] = { terrain: 'forest', decor: 'none' };
    cells[r][cols - 1] = { terrain: 'forest', decor: 'none' };
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = { col: c, row: r };
      if (!inInterior(p, cols, rows)) continue;
      const k = posKey(p);
      if (waterSet.has(k)) cells[r][c] = { terrain: 'water', decor: 'reeds' };
      else if (active.has(k)) cells[r][c] = { terrain: 'grass', decor: 'none' };
      else cells[r][c] = { terrain: 'forest', decor: 'none' };
    }
  }

  // Выходы-маркеры на границе (всегда трава).
  (Object.keys(exits) as ExitDir[]).forEach((dir) => {
    const p = exits[dir];
    if (!p) return;
    cells[p.row][p.col] = { terrain: 'grass', decor: 'none', exit: dir };
  });

  // Декор: пень на E (или первой двери), цветы на W (если есть и не пень) + 1 случайная трава.
  const stumpDir: ExitDir = sides.includes('E') ? 'E' : sides[0];
  const stumpPos = exits[stumpDir] as WorldPos;
  cells[stumpPos.row][stumpPos.col].decor = 'stump';
  const flowerDir: ExitDir | null =
    sides.includes('W') && stumpDir !== 'W' ? 'W' : null;
  const flowerPos = flowerDir ? (exits[flowerDir] as WorldPos) : null;
  if (flowerPos) cells[flowerPos.row][flowerPos.col].decor = 'flowers';
  const flowerPool: WorldPos[] = [];
  for (const k of active) {
    const [c, r] = k.split(',').map(Number);
    const p = { col: c, row: r };
    if (waterSet.has(k)) continue;
    if (posKey(p) === posKey(stumpPos) || (flowerPos && posKey(p) === posKey(flowerPos)) || posKey(p) === spawnKey) continue;
    if (exitKeys.has(posKey(p))) continue;
    flowerPool.push(p);
  }
  if (flowerPool.length > 0) {
    const pick = flowerPool[Math.floor(rand() * flowerPool.length)];
    if (cells[pick.row][pick.col].decor === 'none') cells[pick.row][pick.col].decor = 'flowers';
  }

  // --- Враги: N шт на траве (N из конфига), дистанция от спавна 3+, не на выходах ---
  const wantEnemies = clampInt(opts.enemyCount ?? 2, 1, 8, 2);
  const grassList = [...active]
    .filter((k) => !waterSet.has(k))
    .map((k) => {
      const [c, r] = k.split(',').map(Number);
      return { col: c, row: r };
    })
    .filter((p) => posKey(p) !== spawnKey && !exitKeys.has(posKey(p)));
  const enemies: WorldPos[] = [];
  for (const minDist of [3, 2, 1]) {
    if (enemies.length >= wantEnemies) break;
    const have = new Set(enemies.map(posKey));
    const pool = grassList.filter((p) => !have.has(posKey(p)) && manhattan(p, spawn) >= minDist);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    enemies.push(...pool.slice(0, wantEnemies - enemies.length));
  }

  // --- Торговец: одна клетка травы, не спавн/выход/враг, желательно в 2+ от спавна ---
  const enemyKeys = new Set(enemies.map(posKey));
  let merchant: WorldPos | null = null;
  for (const minDist of [2, 1, 0]) {
    const pool = grassList.filter(
      (p) => !enemyKeys.has(posKey(p)) && manhattan(p, spawn) >= minDist,
    );
    if (pool.length > 0) {
      merchant = pool[Math.floor(rand() * pool.length)];
      break;
    }
  }
  if (!merchant) merchant = { ...spawn };

  const world: World = { cols, rows, cells, spawn: { ...spawn }, enemies, exits, merchant };

  // Защита: связность + хотя бы одна вода, иначе запасной вариант.
  if (!worldPlayable(world, sides) || countTerrain(world, 'water') < 1) {
    return generateWorldFallback(cols, rows, wantEnemies, sides);
  }
  return world;
}

/** Детерминированный запасной вариант — всегда валиден. Коридоры только вдоль требуемых осей. */
function generateWorldFallback(
  cols: number = WORLD_COLS,
  rows: number = WORLD_ROWS,
  wantEnemies = 2,
  sides: ExitDir[] = [...ALL_EXIT_DIRS],
): World {
  const center = centerOf(cols, rows);
  const exits: Partial<Record<ExitDir, WorldPos>> = {};
  if (sides.includes('N')) exits.N = { col: center.col, row: 0 };
  if (sides.includes('S')) exits.S = { col: center.col, row: rows - 1 };
  if (sides.includes('W')) exits.W = { col: 0, row: center.row };
  if (sides.includes('E')) exits.E = { col: cols - 1, row: center.row };
  const spawn: WorldPos = { ...center };
  const cells = emptyCells(cols, rows);
  // Граница — лес, крест коридоров — трава.
  // Граница — лес, коридоры — только вдоль требуемых осей.
  for (let c = 0; c < cols; c++) {
    cells[0][c] = { terrain: 'forest', decor: 'none' };
    cells[rows - 1][c] = { terrain: 'forest', decor: 'none' };
  }
  for (let r = 0; r < rows; r++) {
    cells[r][0] = { terrain: 'forest', decor: 'none' };
    cells[r][cols - 1] = { terrain: 'forest', decor: 'none' };
  }
  const needVertical = sides.includes('N') || sides.includes('S');
  const needHorizontal = sides.includes('E') || sides.includes('W');
  if (needHorizontal) {
    for (let c = 1; c < cols - 1; c++) cells[center.row][c] = { terrain: 'grass', decor: 'none' };
  }
  if (needVertical) {
    for (let r = 1; r < rows - 1; r++) cells[r][center.col] = { terrain: 'grass', decor: 'none' };
  }
  cells[Math.max(1, center.row - 1)][Math.max(1, center.col - 1)] = { terrain: 'water', decor: 'reeds' };
  (Object.keys(exits) as ExitDir[]).forEach((dir) => {
    const p = exits[dir];
    if (!p) return;
    cells[p.row][p.col] = { terrain: 'grass', decor: 'none', exit: dir };
  });
  const stumpPos = exits.E ?? exits[sides[0]];
  if (stumpPos) cells[stumpPos.row][stumpPos.col].decor = 'stump';
  if (exits.W && exits.W !== stumpPos) cells[exits.W.row][exits.W.col].decor = 'flowers';
  const enemies: WorldPos[] = [];
  for (let i = 0; i < wantEnemies; i++) {
    const dx = i % 2 === 0 ? -(3 + Math.floor(i / 2)) : 3 + Math.floor(i / 2);
    enemies.push({
      col: Math.min(cols - 2, Math.max(1, center.col + dx)),
      row: center.row,
    });
  }
  // Торговец рядом со спавном на кресте (трава гарантирована).
  const merchant: WorldPos = {
    col: Math.min(cols - 2, Math.max(1, center.col + 1)),
    row: center.row,
  };
  return { cols, rows, cells, spawn, enemies, exits, merchant };
}

/** Совместимость со старыми сейвами: если merchant нет — чиним на ближайшей траве. */
export function ensureWorldMerchant(world: World): WorldPos {
  const m = (world as Partial<World>).merchant;
  if (m && typeof m.col === 'number' && typeof m.row === 'number' && isWalkable(world, m)) {
    return m;
  }
  const exitKeys = new Set(exitPositions(world.exits).map(posKey));
  const enemyKeys = new Set(world.enemies.map(posKey));
  const spawnKey = posKey(world.spawn);
  let best: WorldPos | null = null;
  let bestDist = -1;
  for (let r = 0; r < world.rows; r++) {
    for (let c = 0; c < world.cols; c++) {
      const p = { col: c, row: r };
      const k = posKey(p);
      if (world.cells[r][c].terrain !== 'grass') continue;
      if (k === spawnKey || exitKeys.has(k) || enemyKeys.has(k)) continue;
      const d = manhattan(p, world.spawn);
      if (d > bestDist) {
        bestDist = d;
        best = p;
      }
    }
  }
  const fixed = best ?? { ...world.spawn };
  world.merchant = fixed;
  return fixed;
}

/** Стоит ли игрок на клетке торговца. */
export function isOnMerchant(world: World, p: WorldPos): boolean {
  const m = (world as Partial<World>).merchant;
  if (!m) return false;
  return m.col === p.col && m.row === p.row;
}

