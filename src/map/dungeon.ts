/**
 * Граф полей подземелья для миникарты.
 * - Каждый узел = одно поле (World). Квадрат на карте как на референсе.
 * - Связи заданы явно через links (коридоры), а не соседством координат.
 * - Fog of war: видны посещённые + прямые соседи текущей комнаты.
 * - RoomType сейчас один ('normal'), union оставлен под будущие
 *   'boss' | 'treasure' | 'shop' | ... — иконки подхватятся автоматически.
 */

export type DungeonDir = 'N' | 'S' | 'E' | 'W';

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
