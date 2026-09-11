import { ComboEngine, type TimeProvider } from './ComboEngine';
import type { ComboData, DamageMultiplier, SwipeDir } from './types';

export interface Continuation {
  comboId: string;
  name: string;
  icon: string;
  /** Что осталось добрать после текущего префикса */
  remaining: SwipeDir[];
  discovered: boolean;
}

export type DiscoveryOutcome =
  | { result: 'next'; prefix: SwipeDir[]; continuations: Continuation[] }
  | { result: 'reset'; prefix: SwipeDir[] }
  | { result: 'expired'; combo: ComboData; elapsedMs: number }
  | {
      result: 'complete';
      combo: ComboData;
      elapsedMs: number;
      multiplier: DamageMultiplier;
      finalDamage: number;
    };

function isPrefix(full: SwipeDir[], prefix: SwipeDir[]): boolean {
  if (prefix.length > full.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (full[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * DiscoveryEngine — несколько комбинаций с общими префиксами.
 *
 * - В начале последовательности скрыты (continuations пусты пока prefix пуст).
 * - Каждый верный свайп сужает кандидатов и показывает их продолжения.
 * - Неверный свайп (префикс не совпал НИ с одной доступной комбинацией) — ЖЕСТКИЙ РЕСЕТ.
 * - Короткое комбо при живом длинном продолжении СРАБАТЫВАЕТ СРАЗУ.
 * - Комбо на перезарядке (excluded) не участвуют в матчинге.
 * - Очень сильные комбо с timeLimitMs: ввод дольше окна — 'expired' без эффекта.
 */
export class DiscoveryEngine {
  private combos: ComboData[];
  private excluded = new Set<string>();
  private discovered = new Set<string>();
  private prefix: SwipeDir[] = [];
  private t0 = 0;
  private readonly now: TimeProvider;

  constructor(combos: ComboData[], now: TimeProvider = () => Date.now()) {
    this.combos = [...combos];
    this.now = now;
    this.t0 = this.now();
  }

  setCombos(combos: ComboData[]): void {
    this.combos = [...combos];
    this.excluded.clear();
    this.resetAttempt();
  }

  /** Id на перезарядке не матчатся (кулдаун в ходах игрока считает контроллер). */
  setExcluded(ids: Iterable<string>): void {
    this.excluded = new Set(ids);
  }

  isExcluded(id: string): boolean {
    return this.excluded.has(id);
  }

  private available(): ComboData[] {
    return this.combos.filter((c) => !this.excluded.has(c.id));
  }

  /** Новая попытка (сброс префикса и таймера скорости). */
  resetAttempt(): void {
    this.prefix = [];
    this.t0 = this.now();
  }

  /** Новый бой: префикс сбрасывается, собранные снова скрываются. */
  newFight(): void {
    this.discovered.clear();
    this.excluded.clear();
    this.resetAttempt();
  }

  /** Следующий раунд/волна: префикс сбрасывается, собранные СОХРАНЯЮТСЯ. */
  nextRound(): void {
    this.resetAttempt();
  }

  input(dir: SwipeDir): DiscoveryOutcome {
    const next: SwipeDir[] = [...this.prefix, dir];
    const candidates = this.available().filter((c) => isPrefix(c.points, next));

    // ЖЕСТКИЙ РЕСЕТ: ни одна доступная комбинация так не продолжается
    if (candidates.length === 0) {
      this.prefix = [];
      this.t0 = this.now();
      return { result: 'reset', prefix: [] };
    }

    this.prefix = next;

    // Короткое срабатывает сразу, даже если есть более длинные продолжения.
    const finished = candidates.find((c) => c.points.length === next.length);
    if (finished) {
      const elapsedMs = this.now() - this.t0;
      if (finished.timeLimitMs > 0 && elapsedMs > finished.timeLimitMs) {
        this.prefix = [];
        this.t0 = this.now();
        return { result: 'expired', combo: finished, elapsedMs };
      }
      const multiplier = ComboEngine.calcMultiplier(elapsedMs, 800, 1500);
      const finalDamage = Math.round(finished.power * multiplier);
      this.discovered.add(finished.id);
      // готовимся к следующей комбинации
      this.prefix = [];
      this.t0 = this.now();
      return { result: 'complete', combo: finished, elapsedMs, multiplier, finalDamage };
    }

    return {
      result: 'next',
      prefix: [...this.prefix],
      continuations: candidates.map((c) => ({
        comboId: c.id,
        name: c.name,
        icon: c.icon,
        remaining: c.points.slice(next.length),
        discovered: this.discovered.has(c.id),
      })),
    };
  }

  /** Продолжения для текущего префикса. Пусто пока игрок ничего не ввел (все скрыто). */
  getContinuations(): Continuation[] {
    if (this.prefix.length === 0) return [];
    return this.available()
      .filter((c) => isPrefix(c.points, this.prefix))
      .map((c) => ({
        comboId: c.id,
        name: c.name,
        icon: c.icon,
        remaining: c.points.slice(this.prefix.length),
        discovered: this.discovered.has(c.id),
      }));
  }

  getPrefix(): SwipeDir[] {
    return [...this.prefix];
  }

  getDiscoveredIds(): string[] {
    return [...this.discovered];
  }

  isDiscovered(id: string): boolean {
    return this.discovered.has(id);
  }

  getDiscoveredCount(): number {
    return this.discovered.size;
  }

  getTotalCount(): number {
    return this.combos.length;
  }
}
