import type { AbilityData, ComboResult, DamageMultiplier, SwipeDir } from './types';

export type TimeProvider = () => number;

export interface ComboCompleteInfo {
  result: 'complete';
  elapsedMs: number;
  multiplier: DamageMultiplier;
  finalDamage: number;
}

export type ComboInputOutcome =
  | { result: 'next'; index: number }
  | { result: 'reset'; index: number }
  | ComboCompleteInfo;

/**
 * ComboEngine — чистая логика комбо без зависимости от Phaser.
 *
 * Правила (жесткий ресет, как в документе):
 * - input сверяется с combo[index]
 * - верно + не последний -> 'next'
 * - верно + последний -> 'complete' (считаем mult по now - t0)
 * - НЕВЕРНО -> 'reset': index = 0, t0 = now, без урона по игроку
 *
 * После 'complete' движок автоматически готовится к следующей попытке
 * (index = 0, t0 = now), а данные завершенной попытки возвращаются в outcome.
 */
export class ComboEngine {
  private ability: AbilityData | null = null;
  private index = 0;
  private t0 = 0;
  private lastElapsedMs = 0;
  private lastMultiplier: DamageMultiplier = 1.0;

  private readonly now: TimeProvider;

  constructor(now: TimeProvider = () => Date.now()) {
    this.now = now;
  }

  start(ability: AbilityData): void {
    this.ability = ability;
    this.index = 0;
    this.t0 = this.now();
    this.lastElapsedMs = 0;
    this.lastMultiplier = 1.0;
  }

  reset(): void {
    this.index = 0;
    if (this.ability) {
      this.t0 = this.now();
    }
  }

  input(dir: SwipeDir): ComboInputOutcome {
    if (!this.ability) {
      return { result: 'reset', index: 0 };
    }

    const expected = this.ability.combo[this.index];

    // ЖЕСТКИЙ РЕСЕТ при ошибке
    if (dir !== expected) {
      this.index = 0;
      this.t0 = this.now();
      return { result: 'reset', index: 0 };
    }

    this.index += 1;

    if (this.index >= this.ability.combo.length) {
      const elapsedMs = this.now() - this.t0;
      const multiplier = ComboEngine.calcMultiplier(
        elapsedMs,
        this.ability.perfectMs,
        this.ability.fastMs,
      );
      const finalDamage = Math.round(this.ability.damage * multiplier);

      this.lastElapsedMs = elapsedMs;
      this.lastMultiplier = multiplier;

      // готовимся к следующей попытке
      this.index = 0;
      this.t0 = this.now();

      return { result: 'complete', elapsedMs, multiplier, finalDamage };
    }

    return { result: 'next', index: this.index };
  }

  static calcMultiplier(
    elapsedMs: number,
    perfectMs: number,
    fastMs: number,
  ): DamageMultiplier {
    if (elapsedMs <= perfectMs) return 1.4;
    if (elapsedMs <= fastMs) return 1.2;
    return 1.0;
  }

  getProgress(): SwipeDir[] {
    if (!this.ability) return [];
    return this.ability.combo.slice(0, this.index);
  }

  getExpected(): SwipeDir | null {
    if (!this.ability) return null;
    return this.ability.combo[this.index] ?? null;
  }

  getIndex(): number {
    return this.index;
  }

  getCombo(): SwipeDir[] {
    return this.ability ? [...this.ability.combo] : [];
  }

  getAbility(): AbilityData | null {
    return this.ability;
  }

  getLastResult(): { elapsedMs: number; multiplier: DamageMultiplier } {
    return { elapsedMs: this.lastElapsedMs, multiplier: this.lastMultiplier };
  }

  isStarted(): boolean {
    return this.ability !== null;
  }
}

export type { ComboResult };
