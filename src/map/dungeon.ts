import { mulberry32 } from './world';

/**
 * Граф полей подземелья для миникарты.
 * - Каждый узел = одно поле (World). Квадрат на карте как на референсе.
 * - Связи заданы явно через links (коридоры), а не соседством координат.
 * - Fog of war: видны посещённые + прямые соседи текущей комнаты.
 * - RoomType сейчас один ('normal'), union оставлен под будущие
 *   'boss' | 'treasure' | 'shop' | ... — иконки подхватятся автоматически.
 */

export type DungeonDir = 'N' | 'S' | 'E' | 'W';

export const DUNGEON_DIRS: readonly DungeonDir[] = ['N', 'S', 'E', 'W'];

/** Тип поля. Пока один, но место под новые заложено в типе и JSON. */
export type RoomType = 'normal';
// Будущее: export type RoomType = 'normal' | 'boss' | 'treasure' | 'shop' | 'event' | 'start';

export interface DungeonLinks {
  N: string | null;
  S: string | null;
  E: string | null;
  W: string | null;
}

export interface DungeonNode {
  id: string;
  /** Координаты на сетке миникарты (могут быть отрицательными). */
  gx: number;
  gy: number;
  type: RoomType;
  /** Seed поля (World) для детерминированной регенерации при возврате. */
  seed: number;
  links: DungeonLinks;
}

export interface DungeonGraph {
  nodes: Map<string, DungeonNode>;
  /** Где сейчас игрок. */
  currentId: string;
  /** Посещённые комнаты — остаются видимыми навсегда. */
  visited: Set<string>;
}

interface RawNode {
  id?: unknown;
  gx?: unknown;
  gy?: unknown;
  type?: unknown;
  seed?: unknown;
  links?: unknown;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
}

function linkId(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function parseLinks(raw: unknown): DungeonLinks {
  const d = (raw ?? {}) as Record<string, unknown>;
  return { N: linkId(d['N']), S: linkId(d['S']), E: linkId(d['E']), W: linkId(d['W']) };
}

/** Разбор JSON данжа с валидацией; битые узлы пропускаются. */
export function parseDungeon(
  raw: unknown,
  opts: { startId?: string } = {},
): DungeonGraph | null {
  const list = (raw as { rooms?: unknown })?.rooms;
  if (!Array.isArray(list) || list.length === 0) return null;
  const nodes = new Map<string, DungeonNode>();
  for (const item of list) {
    const r = (item ?? {}) as RawNode;
    if (typeof r.id !== 'string' || r.id.length === 0) continue;
    if (nodes.has(r.id)) continue;
    // Пока принимаем только 'normal', неизвестное маппим на 'normal'
    // чтобы старый JSON не ронял игру после добавления новых типов.
    const type: RoomType = r.type === 'normal' ? 'normal' : 'normal';
    nodes.set(r.id, {
      id: r.id,
      gx: num(r.gx, 0),
      gy: num(r.gy, 0),
      type,
      seed: num(r.seed, 1000 + nodes.size),
      links: parseLinks(r.links),
    });
  }
  if (nodes.size === 0) return null;
  // Чистим ссылки на несуществующие узлы.
  for (const n of nodes.values()) {
    (Object.keys(n.links) as DungeonDir[]).forEach((d) => {
      const t = n.links[d];
      if (t !== null && !nodes.has(t)) n.links[d] = null;
    });
  }
  const startId =
    opts.startId && nodes.has(opts.startId)
      ? opts.startId
      : ((raw as { start?: unknown }).start as string) &&
          nodes.has((raw as { start?: unknown }).start as string)
        ? ((raw as { start?: unknown }).start as string)
        : [...nodes.keys()][0];
  return { nodes, currentId: startId, visited: new Set([startId]) };
}

export function getNode(graph: DungeonGraph, id: string): DungeonNode | undefined {
  return graph.nodes.get(id);
}

export function currentNode(graph: DungeonGraph): DungeonNode {
  const n = graph.nodes.get(graph.currentId);
  if (!n) throw new Error(`dungeon: current node ${graph.currentId} missing`);
  return n;
}

/** Сосед текущей комнаты в направлении выхода (N/S/E/W). */
export function neighborInDir(
  graph: DungeonGraph,
  fromId: string,
  dir: DungeonDir,
): DungeonNode | null {
  const from = graph.nodes.get(fromId);
  if (!from) return null;
  const next = from.links[dir];
  return next ? (graph.nodes.get(next) ?? null) : null;
}

/** Прямые соседи комнаты (по links). */
export function neighborsOf(graph: DungeonGraph, id: string): DungeonNode[] {
  const n = graph.nodes.get(id);
  if (!n) return [];
  const out: DungeonNode[] = [];
  for (const d of ['N', 'S', 'E', 'W'] as DungeonDir[]) {
    const t = n.links[d];
    if (t) {
      const node = graph.nodes.get(t);
      if (node) out.push(node);
    }
  }
  return out;
}

/**
 * Fog of war: видны посещённые + прямые соседи текущей.
 * Изначально: старт + его соседи (как в ТЗ).
 */
export function visibleIds(graph: DungeonGraph): Set<string> {
  const vis = new Set<string>(graph.visited);
  vis.add(graph.currentId);
  for (const n of neighborsOf(graph, graph.currentId)) vis.add(n.id);
  return vis;
}

export function moveTo(graph: DungeonGraph, nextId: string): void {
  if (!graph.nodes.has(nextId)) return;
  graph.currentId = nextId;
  graph.visited.add(nextId);
}

/** Стороны, на которых у узла есть соседи (= где лабиринт должен прорубить двери). */
export function linkedDirs(node: DungeonNode): DungeonDir[] {
  return (Object.keys(node.links) as DungeonDir[]).filter((d) => node.links[d] !== null);
}

/** Сериализация для save/restore между сценами (реестр / бой). */
export function serializeDungeon(graph: DungeonGraph): { currentId: string; visited: string[] } {
  return { currentId: graph.currentId, visited: [...graph.visited] };
}

export function restoreDungeonState(
  graph: DungeonGraph,
  state: { currentId?: unknown; visited?: unknown } | undefined,
): void {
  if (!state) return;
  if (typeof state.currentId === 'string' && graph.nodes.has(state.currentId)) {
    graph.currentId = state.currentId;
  }
  if (Array.isArray(state.visited)) {
    for (const id of state.visited) {
      if (typeof id === 'string' && graph.nodes.has(id)) graph.visited.add(id);
    }
  }
  graph.visited.add(graph.currentId);
}

// ---------- Процедурная генерация ----------

export interface GenerateDungeonOptions {
  seed?: number;
  /** Сколько комнат (по умолчанию 13, диапазон 4..40). */
  roomCount?: number;
  /** Сколько extra-рёбер добавить сверх дерева = круговых петель (по умолчанию 2). */
  extraLoops?: number;
  /** Габариты сетки размещения (по умолчанию 8×8, теснота даёт петли). */
  width?: number;
  height?: number;
}

const DIR_DELTA: Record<DungeonDir, { dx: number; dy: number }> = {
  N: { dx: 0, dy: -1 },
  S: { dx: 0, dy: 1 },
  W: { dx: -1, dy: 0 },
  E: { dx: 1, dy: 0 },
};

const OPPOSITE_DIR: Record<DungeonDir, DungeonDir> = { N: 'S', S: 'N', W: 'E', E: 'W' };

function clampDungeonInt(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/**
 * Процедурный данж: сначала комнаты, затем связи.
 * - Рост от центра: новая комната цепляется к случайной свободной стороне
 *   случайной комнаты (дерево → связность по построению);
 * - затем extraLoops рёбер между соседними по координатам, но несвязанными
 *   комнатами (круговые обходы);
 * - старт — самая центральная комната; сиды узлов — производные runSeed
 *   (детерминизм возврата и реплеев).
 */
export function generateDungeon(opts: GenerateDungeonOptions = {}): DungeonGraph {
  const seed = opts.seed ?? 12345;
  const rand = mulberry32(seed);
  const target = clampDungeonInt(opts.roomCount ?? 13, 4, 40, 13);
  const width = clampDungeonInt(opts.width ?? 8, 4, 12, 8);
  const height = clampDungeonInt(opts.height ?? 8, 4, 12, 8);
  const wantLoops = clampDungeonInt(opts.extraLoops ?? 2, 0, 8, 2);

  interface GrowRoom {
    id: string;
    gx: number;
    gy: number;
  }
  const rooms: GrowRoom[] = [{ id: 'r0', gx: 0, gy: 0 }];
  const occupied = new Set<string>(['0,0']);
  const links = new Map<string, DungeonLinks>([
    ['r0', { N: null, S: null, E: null, W: null }],
  ]);

  const freeDirs = (gx: number, gy: number, bounded: boolean): DungeonDir[] => {
    const out: DungeonDir[] = [];
    for (const d of DUNGEON_DIRS) {
      const nx = gx + DIR_DELTA[d].dx;
      const ny = gy + DIR_DELTA[d].dy;
      if (bounded && (Math.abs(nx) > width / 2 || Math.abs(ny) > height / 2)) continue;
      if (!occupied.has(`${nx},${ny}`)) out.push(d);
    }
    return out;
  };

  // --- Дерево комнат ---
  let guard = 0;
  let bounded = true;
  while (rooms.length < target && guard++ < 2000) {
    if (guard === 1000) bounded = false; // тесно — снимаем границы, лишь бы достроить
    const host = rooms[Math.floor(rand() * rooms.length)];
    const free = freeDirs(host.gx, host.gy, bounded);
    if (free.length === 0) continue;
    const dir = free[Math.floor(rand() * free.length)];
    const nx = host.gx + DIR_DELTA[dir].dx;
    const ny = host.gy + DIR_DELTA[dir].dy;
    const id = `r${rooms.length}`;
    rooms.push({ id, gx: nx, gy: ny });
    occupied.add(`${nx},${ny}`);
    links.set(id, { N: null, S: null, E: null, W: null });
    (links.get(host.id) as DungeonLinks)[dir] = id;
    (links.get(id) as DungeonLinks)[OPPOSITE_DIR[dir]] = host.id;
  }

  // --- Петли: связать соседние по сетке, но несвязанные комнаты ---
  const byCoord = new Map<string, string>();
  for (const r of rooms) byCoord.set(`${r.gx},${r.gy}`, r.id);
  interface Candidate {
    a: string;
    b: string;
    dir: DungeonDir;
  }
  const candidates: Candidate[] = [];
  for (const r of rooms) {
    for (const d of ['E', 'S'] as DungeonDir[]) {
      const other = byCoord.get(`${r.gx + DIR_DELTA[d].dx},${r.gy + DIR_DELTA[d].dy}`);
      if (!other) continue;
      const lr = links.get(r.id) as DungeonLinks;
      if (lr[d] !== null) continue;
      candidates.push({ a: r.id, b: other, dir: d });
    }
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  for (const c of candidates.slice(0, wantLoops)) {
    (links.get(c.a) as DungeonLinks)[c.dir] = c.b;
    (links.get(c.b) as DungeonLinks)[OPPOSITE_DIR[c.dir]] = c.a;
  }

  // --- Сборка: старт = самая центральная комната ---
  const med = (ns: number[]): number => {
    const s = [...ns].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const mx = med(rooms.map((r) => r.gx));
  const my = med(rooms.map((r) => r.gy));
  let start = rooms[0].id;
  let best = Infinity;
  for (const r of rooms) {
    const d = Math.abs(r.gx - mx) + Math.abs(r.gy - my);
    if (d < best) {
      best = d;
      start = r.id;
    }
  }

  const nodes = new Map<string, DungeonNode>();
  rooms.forEach((r, i) => {
    nodes.set(r.id, {
      id: r.id,
      gx: r.gx,
      gy: r.gy,
      type: 'normal',
      seed: (seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0,
      links: links.get(r.id) as DungeonLinks,
    });
  });
  return { nodes, currentId: start, visited: new Set([start]) };
}

export interface DungeonValidation {
  ok: boolean;
  errors: string[];
}

/** Инварианты графа: симметрия связей, связность (BFS), степень ≥ 1. */
export function validateDungeon(graph: DungeonGraph): DungeonValidation {
  const errors: string[] = [];
  for (const n of graph.nodes.values()) {
    for (const d of DUNGEON_DIRS) {
      const t = n.links[d];
      if (t === null) continue;
      const other = graph.nodes.get(t);
      if (!other) {
        errors.push(`${n.id}.${d} -> missing ${t}`);
      } else if (other.links[OPPOSITE_DIR[d]] !== n.id) {
        errors.push(`asym ${n.id}.${d} -> ${t}`);
      }
    }
    if (linkedDirs(n).length === 0) errors.push(`isolated ${n.id}`);
  }
  const seen = new Set<string>();
  const queue: string[] = [graph.currentId];
  seen.add(graph.currentId);
  while (queue.length > 0) {
    const id = queue.pop() as string;
    for (const nb of neighborsOf(graph, id)) {
      if (!seen.has(nb.id)) {
        seen.add(nb.id);
        queue.push(nb.id);
      }
    }
  }
  if (seen.size !== graph.nodes.size) {
    errors.push(`disconnected: reachable ${seen.size}/${graph.nodes.size}`);
  }
  return { ok: errors.length === 0, errors };
}
