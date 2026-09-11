import { DiscoveryEngine, type DiscoveryOutcome } from './DiscoveryEngine';
import type { TimeProvider } from './ComboEngine';
import type { ComboData, SwipeDir } from './types';

export interface EnemyData {
  id: string;
  name: string;
  emoji?: string;
  /** Ключ текстуры спрайта (загружается в preload сцены). */
  texture?: string;
  maxHp: number;
  damage: number;
  /** Задержка перед ответными ударами после атаки игрока (мс). */
  attackIntervalMs: number;
  /** Сколько ударов наносит противник за свой ход. */
  strikesPerTurn?: number;
  /** Тип атаки из enemies.json: slash / double / crush. */
  attackType?: string;
  /** На сколько растёт урон за каждое следующее поле. */
  damageGrowth?: number;
  /** Вес выбора типа при заселении поля. */
  spawnWeight?: number;
  /** Шанс хода после хода игрока (0..1). */
  moveChance?: number;
  /** Деньги за уничтожение (уходят в магазин торговца). */
  coins?: number;
}

export type Turn = 'player' | 'enemy' | 'over';

export interface CombatSwipeResult {
  outcome: DiscoveryOutcome;
  /** Урон по врагу (damage-комбо) или 0. */
  dealt: number;
  /** Лечение игрока (heal-комбо) или 0. */
  healed: number;
  /** Множитель активного усиления, если было применено к удару. */
  buffUsed: number;
  enemyHp: number;
  enemyDead: boolean;
  /** true если свайп проигнорирован потому что сейчас не ход игрока */
  ignoredNotPlayerTurn: boolean;
}

export interface EnemyStrikeResult {
  enemyHit: boolean;
  damage: number;
  playerHp: number;
  playerDead: boolean;
  strikesLeft: number;
  strikesTotal: number;
}

/**
 * CombatController — пошаговый бой с волнами и комбинациями-эффектами.
 * - Первый удар всегда наносит игрок.
 * - damage/buff_next тратят ход (враг отвечает strikesPerTurn раз);
 *   heal ход НЕ тратит (ответа нет).
 * - Перезарядка сложных комбо — в ходах игрока, не в секундах.
 * - Усиление ×(1+power/100) к следующему damage-удару, затем сгорает.
 */
export class CombatController {
  private discovery: DiscoveryEngine;
  private combos: ComboData[];
  private enemies: EnemyData[];
  private waveIndex = 0;
  private enemyHp: number;
  private playerHp: number;
  private readonly playerMaxHp: number;
  private turn: Turn = 'player';
  private strikesLeft = 0;
  private coins = 0;
  /** Счетчик завершенных комбо игрока; кулдауны меряются в нем. */
  private turnCount = 0;
  /** id -> номер хода, с которого комбо снова доступно. */
  private readyAt = new Map<string, number>();
  /** Множитель висящего усиления (null — нет). */
  private buffMult: number | null = null;
  private readonly now: TimeProvider;

  constructor(
    opts: {
      enemy?: EnemyData;
      enemies?: EnemyData[];
      combos?: ComboData[];
      /** @deprecated используйте combos */
      abilities?: ComboData[];
      playerMaxHp?: number;
      /** Стартовое HP (для дуэли с поля); по умолчанию = max. */
      playerHp?: number;
      now?: TimeProvider;
    },
    now: TimeProvider = () => Date.now(),
  ) {
    this.now = opts.now ?? now;
    const list = opts.enemies && opts.enemies.length > 0 ? opts.enemies : opts.enemy ? [opts.enemy] : [];
    if (list.length === 0) {
      throw new Error('CombatController: нужен хотя бы один противник');
    }
    this.enemies = [...list];
    this.combos = [...(opts.combos ?? opts.abilities ?? [])];
    this.enemyHp = this.currentEnemy().maxHp;
    this.playerMaxHp = opts.playerMaxHp ?? 150;
    const startHp = opts.playerHp ?? this.playerMaxHp;
    this.playerHp = Math.min(this.playerMaxHp, Math.max(1, startHp));
    this.discovery = new DiscoveryEngine(this.combos, this.now);
    this.refreshExcluded();
  }

  get coinReward(): number {
    return this.coinsForCurrent();
  }

  /** Деньги за текущего врага: поле coins из enemies.json, фолбэк 15. */
  coinsForCurrent(): number {
    const c = this.currentEnemy().coins;
    return typeof c === 'number' && Number.isFinite(c) ? Math.max(0, Math.round(c)) : 15;
  }

  /** Деньги за врага по id (для сцены карты без контроллера). */
  coinRewardFor(enemyId: string): number {
    const found = this.enemies.find((e) => e.id === enemyId);
    const c = found?.coins;
    return typeof c === 'number' && Number.isFinite(c) ? Math.max(0, Math.round(c)) : 15;
  }

  private currentEnemy(): EnemyData {
    return this.enemies[this.waveIndex];
  }

  getEnemy(): EnemyData {
    return this.currentEnemy();
  }

  getWaveIndex(): number {
    return this.waveIndex;
  }

  getWaveTotal(): number {
    return this.enemies.length;
  }

  getWaveText(): string {
    return `Волна ${this.waveIndex + 1}/${this.enemies.length}`;
  }

  hasNextWave(): boolean {
    return this.waveIndex + 1 < this.enemies.length;
  }

  getStrikesLeft(): number {
    return this.strikesLeft;
  }

  getStrikesTotal(): number {
    return this.currentEnemy().strikesPerTurn ?? 1;
  }

  getTurn(): Turn {
    return this.turn;
  }

  isPlayerTurn(): boolean {
    return this.turn === 'player';
  }

  getDiscovery(): DiscoveryEngine {
    return this.discovery;
  }

  getCombos(): ComboData[] {
    return [...this.combos];
  }

  /** @deprecated используйте getCombos */
  getAbilities(): ComboData[] {
    return this.getCombos();
  }

  getBuffMult(): number | null {
    return this.buffMult;
  }

  /** Остаток перезарядки в ходах игрока (0 — доступно). */
  getCooldownLeft(id: string): number {
    return Math.max(0, (this.readyAt.get(id) ?? 0) - this.turnCount);
  }

  getCooldowns(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of this.combos) {
      const left = this.getCooldownLeft(c.id);
      if (left > 0) out[c.id] = left;
    }
    return out;
  }

  private refreshExcluded(): void {
    const ids = this.combos.filter((c) => this.getCooldownLeft(c.id) > 0).map((c) => c.id);
    this.discovery.setExcluded(ids);
  }

  handleSwipe(dir: SwipeDir): CombatSwipeResult {
    const idle = {
      outcome: { result: 'reset', prefix: this.discovery.getPrefix() } as DiscoveryOutcome,
      dealt: 0,
      healed: 0,
      buffUsed: 0,
      enemyHp: this.enemyHp,
      enemyDead: this.isEnemyDead(),
      ignoredNotPlayerTurn: true,
    };
    if (this.isGameOver() || this.turn !== 'player') return idle;

    const outcome = this.discovery.input(dir);

    if (outcome.result !== 'complete') {
      return {
        outcome,
        dealt: 0,
        healed: 0,
        buffUsed: 0,
        enemyHp: this.enemyHp,
        enemyDead: false,
        ignoredNotPlayerTurn: false,
      };
    }

    const combo = outcome.combo;
    // Каждый завершенный ввод — ход игрока для кулдаунов.
    this.turnCount += 1;
    this.readyAt.set(combo.id, this.turnCount + combo.cooldownTurns);
    this.refreshExcluded();

    if (combo.kind === 'heal') {
      const healed = Math.min(combo.power, this.playerMaxHp - this.playerHp);
      this.playerHp += healed;
      // Лечение ход НЕ тратит: враг не отвечает.
      return {
        outcome,
        dealt: 0,
        healed,
        buffUsed: 0,
        enemyHp: this.enemyHp,
        enemyDead: false,
        ignoredNotPlayerTurn: false,
      };
    }

    if (combo.kind === 'buff_next') {
      this.buffMult = 1 + combo.power / 100;
      // Усиление ход тратит: враг отвечает.
      this.turn = 'enemy';
      this.strikesLeft = this.getStrikesTotal();
      return {
        outcome,
        dealt: 0,
        healed: 0,
        buffUsed: 0,
        enemyHp: this.enemyHp,
        enemyDead: false,
        ignoredNotPlayerTurn: false,
      };
    }

    // damage
    const buffUsed = this.buffMult ?? 0;
    const total = Math.round(outcome.finalDamage * (this.buffMult ?? 1));
    this.buffMult = null;
    this.enemyHp = Math.max(0, this.enemyHp - total);
    const dead = this.enemyHp <= 0;
    if (dead) {
      this.turn = 'over';
      this.coins += this.coinReward;
    } else {
      this.turn = 'enemy';
      this.strikesLeft = this.getStrikesTotal();
    }
    return {
      outcome,
      dealt: total,
      healed: 0,
      buffUsed,
      enemyHp: this.enemyHp,
      enemyDead: dead,
      ignoredNotPlayerTurn: false,
    };
  }

  /**
   * ОДИН ответный удар противника. Сцена вызывает повторно с задержкой,
   * пока strikesLeft > 0 и оба живы (число ходов противника за ход).
   */
  enemyStrike(): EnemyStrikeResult {
    const total = this.getStrikesTotal();
    const noHit: EnemyStrikeResult = {
      enemyHit: false,
      damage: 0,
      playerHp: this.playerHp,
      playerDead: this.isPlayerDead(),
      strikesLeft: this.strikesLeft,
      strikesTotal: total,
    };
    if (this.isGameOver()) return noHit;
    if (this.turn !== 'enemy') return noHit;

    this.playerHp = Math.max(0, this.playerHp - this.currentEnemy().damage);
    const playerDead = this.playerHp <= 0;
    this.strikesLeft = Math.max(0, this.strikesLeft - 1);

    if (playerDead) {
      this.turn = 'over';
    } else if (this.strikesLeft > 0) {
      this.turn = 'enemy';
    } else {
      this.turn = 'player';
    }
    return {
      enemyHit: true,
      damage: this.currentEnemy().damage,
      playerHp: this.playerHp,
      playerDead,
      strikesLeft: this.strikesLeft,
      strikesTotal: total,
    };
  }

  /** Перейти к следующей волне. Возвращает false если волн больше нет. */
  nextWave(): boolean {
    if (!this.hasNextWave()) return false;
    this.waveIndex += 1;
    this.enemyHp = this.currentEnemy().maxHp;
    this.strikesLeft = 0;
    this.turn = 'player';
    // Усиление сгорает между волнами, кулдауны и собранные — сохраняются.
    this.buffMult = null;
    this.discovery.nextRound();
    return true;
  }

  getCounterDelayMs(): number {
    return this.currentEnemy().attackIntervalMs;
  }

  /** Полный рестарт: первая волна, комбо/кулдауны/бафф сброшены. */
  resetFight(enemies?: EnemyData[], combos?: ComboData[]): void {
    if (enemies && enemies.length > 0) this.enemies = [...enemies];
    if (combos) {
      this.combos = [...combos];
      this.discovery.setCombos(this.combos);
    }
    this.waveIndex = 0;
    this.enemyHp = this.currentEnemy().maxHp;
    this.playerHp = this.playerMaxHp;
    this.turn = 'player';
    this.strikesLeft = 0;
    this.turnCount = 0;
    this.readyAt.clear();
    this.buffMult = null;
    this.discovery.newFight();
  }

  getEnemyHp(): number {
    return this.enemyHp;
  }

  getEnemyMaxHp(): number {
    return this.currentEnemy().maxHp;
  }

  getPlayerHp(): number {
    return this.playerHp;
  }

  getPlayerMaxHp(): number {
    return this.playerMaxHp;
  }

  getCoins(): number {
    return this.coins;
  }

  isEnemyDead(): boolean {
    return this.enemyHp <= 0;
  }

  isPlayerDead(): boolean {
    return this.playerHp <= 0;
  }

  /** Мертв ли текущий противник или игрок (текущая волна окончена). */
  isDead(): boolean {
    return this.isEnemyDead() || this.isPlayerDead();
  }

  /** Игра окончена: игрок мертв или убита последняя волна. */
  isGameOver(): boolean {
    if (this.isPlayerDead()) return true;
    return this.isEnemyDead() && !this.hasNextWave();
  }

  /** Победа: последняя волна убита, игрок жив. */
  isVictory(): boolean {
    return !this.isPlayerDead() && this.isEnemyDead() && !this.hasNextWave();
  }
}
