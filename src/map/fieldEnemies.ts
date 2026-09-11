import type { World, WorldPos } from './world';
import { isInsideWorld } from './world';

/**
 * Полевые противники: ходят ТОЛЬКО вслед за ходом игрока.
 * - Вероятность хода зависит от «лёгкости»: чем слабее (меньше maxHp),
 *   тем выше шанс сдвинуться после хода игрока.
 * - Самый слабый — наблюдатель-преследователь: видит только по
 *   горизонтали/вертикали, идёт к игроку; потеряв из виду — идёт
 *   к клетке, где видел игрока в последний раз.
 * - Остальные — бродяги: случайный шаг на соседнюю траву.
 */

export type EnemyRole = 'chaser' | 'roamer';

export interface FieldEnemy {
  uid: number;
  /** id из enemies.json (колода из 9: enemy_moth ... boss_hollow) */
  enemyId: string;
  col: number;
  row: number;
  /** шанс сделать ход после хода игрока (0..1). */
  moveChance: number;
  role: EnemyRole;
  /** куда идёт преследователь, потеряв игрока из виду. */
  lastSeen: WorldPos | null;
  alive: boolean;
}

/** Шанс хода после хода игрока: слабее => выше. Синхронизировано с enemies.json. */
export const MOVE_CHANCE_BY_ID: Record<string, number> = {
  enemy_moth: 0.9,
  enemy_slime: 0.75,
  enemy_gator: 0.7,
  elite_wraith: 0.5,
  elite_thorn: 0.4,
  elite_owbear: 0.35,
  miniboss_boar: 0.25,
  miniboss_myconid: 0.2,
  boss_hollow: 0.15,
  // Легаси-сейвы:
  enemy_1: 0.9,
  enemy_2: 0.5,
  enemy_boss: 0.15,
};

/** Фолбэк по HP если id неизвестен: легче => выше шанс. */
export function moveChanceFor(enemyId: string, maxHp?: number): number {
  const direct = MOVE_CHANCE_BY_ID[enemyId];
  if (direct !== undefined) return direct;
  if (typeof maxHp === 'number' && maxHp > 0) {
    // 60HP -> ~0.9, 90HP -> ~0.6, 130HP -> ~0.2
    const v = 1.35 - maxHp / 100;
    return Math.min(0.95, Math.max(0.1, v));
  }
  return 0.5;
}

export function enemyPos(e: FieldEnemy): WorldPos {
  return { col: e.col, row: e.row };
}

function key(p: WorldPos): string {
  return `${p.col},${p.row}`;
}

/**
 * Создать полевых врагов из позиций мира.
 * Первая позиция — слабейший наблюдатель (chaser), остальные — roamer.
 * @param positions клетки из world.enemies
 * @param enemyIds какие типы поставить (по порядку); по умолчанию
 *   regular-колода по кругу — слабейший всегда первый (pickEnemyIds).
 */
export function createFieldEnemies(
  positions: WorldPos[],
  enemyIds: string[] = ['enemy_moth', 'enemy_gator', 'enemy_slime'],
  chances: Record<string, number> = MOVE_CHANCE_BY_ID,
): FieldEnemy[] {
  return positions.map((p, i) => {
    const enemyId = enemyIds[i % enemyIds.length] ?? 'enemy_moth';
    const chance = chances[enemyId] ?? moveChanceFor(enemyId);
    return {
      uid: i,
      enemyId,
      col: p.col,
      row: p.row,
      moveChance: chance,
      role: i === 0 ? 'chaser' : 'roamer',
      lastSeen: null,
      alive: true,
    } as FieldEnemy;
  });
}

/** Ходибельна ли клетка для врага: внутри поля и трава. */
export function isEnemyWalkable(world: World, p: WorldPos): boolean {
  if (!isInsideWorld(world, p)) return false;
  return world.cells[p.row][p.col].terrain === 'grass';
}

/**
 * Видит ли враг игрока: строго одна горизонталь/вертикаль,
 * все клетки между — трава (лес/вода/пустота закрывают обзор).
 * Дистанция не ограничена — как в ТЗ.
 */
export function hasLineOfSight(world: World, from: WorldPos, to: WorldPos): boolean {
  if (from.col === to.col && from.row === to.row) return true;
  if (from.col !== to.col && from.row !== to.row) return false;
  if (from.col === to.col) {
    const step = Math.sign(to.row - from.row);
    for (let r = from.row + step; r !== to.row; r += step) {
      if (world.cells[r]?.[from.col]?.terrain !== 'grass') return false;
    }
    return true;
  }
  const step = Math.sign(to.col - from.col);
  for (let c = from.col + step; c !== to.col; c += step) {
    if (world.cells[from.row]?.[c]?.terrain !== 'grass') return false;
  }
  return true;
}

function ortho(p: WorldPos): WorldPos[] {
  return [
    { col: p.col + 1, row: p.row },
    { col: p.col - 1, row: p.row },
    { col: p.col, row: p.row + 1 },
    { col: p.col, row: p.row - 1 },
  ];
}

/**
 * BFS: следующий шаг от from к target по траве.
 * occupied — клетки других живых врагов (цель разрешена).
 * Возвращает null если уже на цели или пути нет.
 */
export function bfsNextStep(
  world: World,
  from: WorldPos,
  target: WorldPos,
  occupied: Set<string> = new Set(),
): WorldPos | null {
  if (from.col === target.col && from.row === target.row) return null;
  if (!isEnemyWalkable(world, target)) {
    // Цель-игрок всегда на траве; lastSeen тоже. Иначе идти некуда.
    return null;
  }
  const startKey = key(from);
  const targetKey = key(target);
  const prev = new Map<string, string>();
  const seen = new Set<string>([startKey]);
  const queue: WorldPos[] = [{ ...from }];
  const posByKey = new Map<string, WorldPos>([[startKey, { ...from }]]);
  while (queue.length > 0) {
    const cur = queue.shift() as WorldPos;
    for (const n of ortho(cur)) {
      const k = key(n);
      if (seen.has(k)) continue;
      if (!isEnemyWalkable(world, n)) continue;
      // Чужие враги — стена, кроме самой цели.
      if (occupied.has(k) && k !== targetKey) continue;
      seen.add(k);
      prev.set(k, key(cur));
      posByKey.set(k, { ...n });
      if (k === targetKey) {
        // Восстановить первый шаг от старта.
        let walk = targetKey;
        let p = prev.get(walk) as string;
        while (p !== startKey) {
          walk = p;
          p = prev.get(walk) as string;
        }
        return posByKey.get(walk) as WorldPos;
      }
      queue.push(n);
    }
  }
  return null;
}

/** Случайная соседняя трава (не занята другими). null — хода нет. */
export function randomNeighborStep(
  world: World,
  from: WorldPos,
  occupied: Set<string>,
  rand: () => number = Math.random,
): WorldPos | null {
  const opts = ortho(from).filter((p) => isEnemyWalkable(world, p) && !occupied.has(key(p)));
  if (opts.length === 0) return null;
  return opts[Math.floor(rand() * opts.length)];
}

export interface ChaserDecision {
  next: WorldPos | null;
  lastSeen: WorldPos | null;
  saw: boolean;
}

/**
 * Шаг наблюдателя-преследователя (самый слабый):
 * - видит (горизонталь/вертикаль без стен) => запоминает клетку игрока,
 *   идёт к нему по кратчайшему пути;
 * - не видит, но есть lastSeen => идёт к lastSeen; дойдя — забывает её
 *   (остаётся ждать, пока игрок снова покажется);
 * - иначе стоит.
 */
export function decideChaserStep(
  world: World,
  enemy: FieldEnemy,
  player: WorldPos,
  occupied: Set<string>,
): ChaserDecision {
  const from = enemyPos(enemy);
  const saw = hasLineOfSight(world, from, player);
  if (saw) {
    const lastSeen = { ...player };
    const next = bfsNextStep(world, from, player, occupied);
    return { next, lastSeen, saw: true };
  }
  const remembered = enemy.lastSeen ? { ...enemy.lastSeen } : null;
  if (!remembered) return { next: null, lastSeen: null, saw: false };
  if (from.col === remembered.col && from.row === remembered.row) {
    // Дошёл до клетки последнего контакта — ждёт там.
    return { next: null, lastSeen: null, saw: false };
  }
  const next = bfsNextStep(world, from, remembered, occupied);
  // Тупик: путь к lastSeen закрыт (не должно быть на связной траве,
  // но не виснем) — забываем точку чтобы не дёргаться.
  if (!next) return { next: null, lastSeen: null, saw: false };
  return { next, lastSeen: remembered, saw: false };
}

/**
 * Один ход всех врагов вслед за УСПЕШНЫМ ходом игрока.
 * Мутирует позиции в массиве (удобно для сцены) и возвращает врага,
 * который вошёл в клетку игрока (триггер боя), либо null.
 * @param roll бросок вероятности (по умолчанию Math.random) — для тестов можно подсунуть.
 */
export function moveEnemiesAfterPlayer(
  world: World,
  enemies: FieldEnemy[],
  player: WorldPos,
  rand: () => number = Math.random,
): { entered: FieldEnemy | null; moved: FieldEnemy[] } {
  const moved: FieldEnemy[] = [];
  let entered: FieldEnemy | null = null;
  const occupied = new Set(
    enemies.filter((e) => e.alive).map((e) => key(enemyPos(e))),
  );
  for (const e of enemies) {
    if (!e.alive) continue;
    if (entered && e.role !== 'chaser') {
      // Бой уже спровоцирован — остальных не двигаем чтобы не налезть кучей.
      // Преследователю всё равно даём дойти? Нет — стоп после первого входа.
      continue;
    }
    if (rand() >= e.moveChance) continue;
    // Освобождаем свою клетку на время поиска пути.
    occupied.delete(key(enemyPos(e)));
    let dest: WorldPos | null = null;
    if (e.role === 'chaser') {
      const d = decideChaserStep(world, e, player, occupied);
      e.lastSeen = d.lastSeen;
      dest = d.next;
    } else {
      // Бродяга идёт только если НЕ стоит на игроке (иначе бой уже был бы).
      dest = randomNeighborStep(world, enemyPos(e), occupied, rand);
      // Не даём бродяге убежать с клетки игрока если он туда встал раньше —
      // но такой случай сразу превращается в бой ниже.
    }
    if (dest) {
      e.col = dest.col;
      e.row = dest.row;
      moved.push(e);
    }
    occupied.add(key(enemyPos(e)));
    if (e.col === player.col && e.row === player.row) {
      entered = e;
      break;
    }
  }
  return { entered, moved };
}

/** Враг на клетке игрока (игрок сам шагнул на врага). */
export function enemyOnPlayer(enemies: FieldEnemy[], player: WorldPos): FieldEnemy | null {
  for (const e of enemies) {
    if (!e.alive) continue;
    if (e.col === player.col && e.row === player.row) return e;
  }
  return null;
}

/** Живые враги рядом (манхэттен = 1) — для предупреждения «враг рядом!». */
export function adjacentEnemies(enemies: FieldEnemy[], player: WorldPos): FieldEnemy[] {
  return enemies.filter(
    (e) => e.alive && Math.abs(e.col - player.col) + Math.abs(e.row - player.row) === 1,
  );
}
