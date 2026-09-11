export type SwipeDir = 'Up' | 'Down' | 'Left' | 'Right';

export type ComboResult = 'next' | 'complete' | 'reset';

export type DamageMultiplier = 1.0 | 1.2 | 1.4;

export interface AbilityData {
  id: string;
  name: string;
  combo: SwipeDir[];
  damage: number;
  cooldownMs: number;
  /** <= perfectMs -> x1.4 */
  perfectMs: number;
  /** <= fastMs -> x1.2, else x1.0 */
  fastMs: number;
}

export const SWIPE_ARROW: Record<SwipeDir, string> = {
  Up: '↑',
  Right: '→',
  Down: '↓',
  Left: '←',
};

export type ComboKind = 'damage' | 'buff_next' | 'heal';

/**
 * Комбинация из отдельного JSON (src/data/combos.json).
 * - points: из каких свайпов состоит
 * - kind/power: damage — урон; buff_next — +power% к следующему удару; heal — восстановить power HP
 * - cooldownTurns: недоступна столько СВОИХ следующих ходов (0 — всегда доступна)
 * - consumesTurn: тратит ли ход (враг отвечает); heal — нет
 * - timeLimitMs: окно на ввод для очень сильных (0 — без лимита)
 */
export interface ComboData {
  id: string;
  name: string;
  icon: string;
  points: SwipeDir[];
  kind: ComboKind;
  power: number;
  cooldownTurns: number;
  consumesTurn: boolean;
  timeLimitMs: number;
}
