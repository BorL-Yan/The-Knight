import type { SwipeDir } from '../combat/types';

/** Тестовое матричное поле. Только для проверки перемещения. */
export const MAP_TEST_COLS = 7;
export const MAP_TEST_ROWS = 14;

/** Доля леса: 10–20%. Цель генерации — середина диапазона. */
export const FOREST_MIN_RATIO = 0.1;
export const FOREST_MAX_RATIO = 0.2;
export const FOREST_TARGET_RATIO = 0.15;

export type MapCellType = 'empty' | 'forest';

export interface MapPos {
  col: number;
  row: number;
}

export interface MapTestGrid {
  cols: number;
  rows: number;
  /** cells[row][col] */
  cells: MapCellType[][];
  spawn: MapPos;
}

export function isInside(grid: MapTestGrid, pos: MapPos): boolean {
  return pos.col >= 0 && pos.col < grid.cols && pos.row >= 0 && pos.row < grid.rows;
}

export function isBlocked(grid: MapTestGrid, pos: MapPos): boolean {
  if (!isInside(grid, pos)) return true;
  return grid.cells[pos.row][pos.col] === 'forest';
}

export function canStand(grid: MapTestGrid, pos: MapPos): boolean {
  return isInside(grid, pos) && !isBlocked(grid, pos);
}

export function forestRatio(grid: MapTestGrid): number {
  let forest = 0;
  for (const row of grid.cells) for (const c of row) if (c === 'forest') forest++;
  return forest / (grid.cols * grid.rows);
}

export function countCells(grid: MapTestGrid, type: MapCellType): number {
  let n = 0;
  for (const row of grid.cells) for (const c of row) if (c === type) n++;
  return n;
}

function dirDelta(dir: SwipeDir): MapPos {
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

export interface StepResult {
  next: MapPos;
  moved: boolean;
  reason: 'ok' | 'forest' | 'edge';
}

/**
 * Скольжение = ровно одна ячейка (по документу §6).
 * Лес и границы — непроходимы.
 */
export function tryStep(grid: MapTestGrid, from: MapPos, dir: SwipeDir): StepResult {
  const d = dirDelta(dir);
  const next: MapPos = { col: from.col + d.col, row: from.row + d.row };
  if (!isInside(grid, next)) return { next: from, moved: false, reason: 'edge' };
  if (grid.cells[next.row][next.col] === 'forest') return { next: from, moved: false, reason: 'forest' };
  return { next, moved: true, reason: 'ok' };
}

/** Маленький seeded RNG (mulberry32) чтобы тестовое поле было воспроизводимым. */
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

function key(p: MapPos): string {
  return `${p.col},${p.row}`;
}

/** BFS по пустым клеткам от старта. */
export function reachableFrom(grid: MapTestGrid, start: MapPos): Set<string> {
  const seen = new Set<string>();
  if (!canStand(grid, start)) return seen;
  const queue: MapPos[] = [start];
  seen.add(key(start));
  while (queue.length > 0) {
    const cur = queue.pop() as MapPos;
    const neigh: MapPos[] = [
      { col: cur.col + 1, row: cur.row },
      { col: cur.col - 1, row: cur.row },
      { col: cur.col, row: cur.row + 1 },
      { col: cur.col, row: cur.row - 1 },
    ];
    for (const n of neigh) {
      if (!canStand(grid, n)) continue;
      const k = key(n);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push(n);
    }
  }
  return seen;
}

/**
 * Проверка сквозных путей: все 4 стороны соединены пустыми клетками.
 * Условие: существует пустая клетка на каждой стороне, все они достижимы
 * друг из друга по пустым клеткам (через общий компонент связности).
 */
export function sidesConnected(grid: MapTestGrid): boolean {
  const pick = (cells: MapPos[]): MapPos | null => {
    for (const p of cells) if (canStand(grid, p)) return p;
    return null;
  };
  const top: MapPos[] = [];
  const bottom: MapPos[] = [];
  const left: MapPos[] = [];
  const right: MapPos[] = [];
  for (let c = 0; c < grid.cols; c++) {
    top.push({ col: c, row: 0 });
    bottom.push({ col: c, row: grid.rows - 1 });
  }
  for (let r = 0; r < grid.rows; r++) {
    left.push({ col: 0, row: r });
    right.push({ col: grid.cols - 1, row: r });
  }
  const t = pick(top);
  const b = pick(bottom);
  const l = pick(left);
  const r = pick(right);
  if (!t || !b || !l || !r) return false;
  const reach = reachableFrom(grid, t);
  return reach.has(key(b)) && reach.has(key(l)) && reach.has(key(r));
}

export interface GenerateOptions {
  seed?: number;
  forestRatio?: number;
  cols?: number;
  rows?: number;
}

/**
 * Генерация тестового поля 7×14:
 * - всё пустое, затем лес 10–20%;
 * - сквозной «выпуклый» крест (средняя строка + средний столбец) всегда пуст —
 *   он соединяет все 4 стороны экрана;
 * - спавн в центре креста;
 * - изолированные пустые карманы превращаем в лес, чтобы всё пустое было
 *   одной связной областью (тупиков-островов нет).
 */
export function generateMapTestGrid(opts: GenerateOptions = {}): MapTestGrid {
  const cols = opts.cols ?? MAP_TEST_COLS;
  const rows = opts.rows ?? MAP_TEST_ROWS;
  const target = opts.forestRatio ?? FOREST_TARGET_RATIO;
  const clamped = Math.min(FOREST_MAX_RATIO, Math.max(FOREST_MIN_RATIO, target));
  const rand = mulberry32(opts.seed ?? 12345);

  const cells: MapCellType[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => 'empty' as MapCellType),
  );

  const midCol = Math.floor(cols / 2);
  const midRow = Math.floor(rows / 2);
  const spawn: MapPos = { col: midCol, row: midRow };
  const cross = new Set<string>();
  for (let c = 0; c < cols; c++) cross.add(key({ col: c, row: midRow }));
  for (let r = 0; r < rows; r++) cross.add(key({ col: midCol, row: r }));
  cross.add(key(spawn));

  // Кандидаты под лес — всё кроме креста.
  const candidates: MapPos[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (cross.has(key({ col: c, row: r }))) continue;
      candidates.push({ col: c, row: r });
    }
  }
  // Перемешать Фишером–Йетсом на seeded RNG.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[i], candidates[j]];
  }

  const total = cols * rows;
  const wantForest = Math.round(total * clamped);
  const take = Math.min(wantForest, candidates.length);
  for (let i = 0; i < take; i++) {
    const p = candidates[i];
    cells[p.row][p.col] = 'forest';
  }

  const grid: MapTestGrid = { cols, rows, cells, spawn };

  // Убрать изолированные пустые карманы: всё пустое должно быть достижимо из спавна.
  const reach = reachableFrom(grid, spawn);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (cells[r][c] === 'empty' && !reach.has(key({ col: c, row: r }))) {
        cells[r][c] = 'forest';
      }
    }
  }

  return grid;
}
