import Phaser from 'phaser';
import type { SwipeDir } from '../combat/types';
import { SWIPE_ARROW } from '../combat/types';
import { SwipeInput } from '../input/SwipeInput';
import { applyThickFont, thicken } from '../ui/font';
import { sfx } from '../audio/sfx';
import {
  countTerrain,
  ensureWorldMerchant,
  generateWorld,
  isOnMerchant,
  tryStepWorld,
  worldPlayable,
  type ExitDir,
  type World,
  type WorldPos,
} from '../map/world';
import {
  adjacentEnemies,
  createFieldEnemies,
  enemyOnPlayer,
  hasLineOfSight,
  moveEnemiesAfterPlayer,
  type FieldEnemy,
} from '../map/fieldEnemies';
import {
  ENEMY_CATALOG,
  FIELD_CONFIG,
  coinsFor,
  enemyById,
  moveChances,
  normalizeEnemyId,
  pickEnemyIds,
  scaledDamage,
} from '../map/fieldConfig';
import combosJson from '../data/combos.json';
import type { ComboData } from '../combat/types';
import {
  SHOP_CONFIG,
  buyCost,
  cloneProgress,
  coinsForEnemy,
  defaultProgress,
  effectivePower,
  loadProgress,
  rollShopOffers,
  sanitizeOffers,
  starLevel,
  starsText,
  upgradeCost,
  type PlayerProgressData,
  type ShopOffers,
} from '../combat/playerProgress';
import revealDef from '../data/reveal_config.json';
import dungeonTestJson from '../data/dungeon_test.json';
import { DEFAULT_REVEAL, parseRevealConfig, type RevealConfig } from '../map/revealConfig';
import { SHOP_FIELD } from '../map/shopFieldConfig';
import {
  currentNode,
  generateDungeon,
  linkedDirs,
  moveTo,
  neighborInDir,
  parseDungeon,
  restoreDungeonState,
  serializeDungeon,
  type DungeonGraph,
} from '../map/dungeon';
import { DungeonMinimap } from '../ui/DungeonMinimap';

const HERO_TEXTURE = 'map_herro';
const PLAYER_MAX_HP = 150;
const MERCHANT_EMOJI = '🏪';

const ALL_COMBOS = combosJson as ComboData[];
const COMBO_BY_ID = new Map<string, ComboData>(ALL_COMBOS.map((c) => [c.id, c]));

const ENEMY_EMOJI: Record<string, string> = Object.fromEntries(
  (ENEMY_CATALOG as Array<{ id: string; emoji?: string }>).map((e) => [e.id, e.emoji ?? '💀']),
);

function enemyEmoji(id: string): string {
  const norm = normalizeEnemyId(id);
  return ENEMY_EMOJI[norm] ?? ENEMY_EMOJI[id] ?? '💀';
}

function enemyName(id: string): string {
  const norm = normalizeEnemyId(id);
  return enemyById(norm)?.name ?? enemyById(id)?.name ?? norm;
}

/** Ключ map-текстуры колоды врага. */
function enemyMapKey(id: string): string {
  return `map_${normalizeEnemyId(id)}`;
}

function enemyLabel(id: string): string {
  return `${enemyEmoji(id)} ${enemyName(id)}`;
}

const EXIT_ARROW: Record<ExitDir, string> = { N: '▲', S: '▼', W: '◀', E: '▶' };
/** Откуда идёт волна появления поля: сторона входа при переходе или центр. */
type RevealOrigin = ExitDir | 'center';
/** Куда «наружу» ведёт каждый выход. */
const EXIT_OUTWARD: Record<ExitDir, SwipeDir> = { N: 'Up', S: 'Down', W: 'Left', E: 'Right' };
/** Зеркальный выход: вышли через N — появились через S следующего поля. */
const OPPOSITE_EXIT: Record<ExitDir, ExitDir> = { N: 'S', S: 'N', W: 'E', E: 'W' };
const DECOR_EMOJI: Record<string, string> = {
  stump: '🪵',
  flowers: '🌼',
  reeds: '🌾',
};

interface SavedMapState {
  world: World;
  player: WorldPos;
  fieldEnemies: FieldEnemy[];
  playerHp: number;
  moves: number;
  bumps: number;
  visits: string[];
  seed: number;
  fieldNum: number;
  dungeon: { currentId: string; visited: string[] } | null;
  nodeCache: Record<string, { world: World; fieldEnemies: FieldEnemy[] }>;
}

interface DuelResult {
  uid: number;
  victory: boolean;
  playerHpLeft: number;
  /** Деньги за убитого (уже зачислены в registry-прогресс сценой боя). */
  coinsEarned?: number;
}

/**
 * TEST-сцена: серый прототип полей-лабиринтов.
 * Только случайная генерация (размеры и враги из field_config.json):
 * граница-лес с одним выходом на сторону, тропы от выходов к центру.
 * 4 выхода N/S/E/W, свайп = 1 клетка. Клавиша R — новое поле (seed+1).
 * Шаг с клетки выхода наружу — переход на следующее поле;
 * появление — через зеркальный выход (вышли N — встали на S).
 *
 * Противники:
 * - ходят ТОЛЬКО вслед за успешным ходом игрока, шанс хода зависит
 *   от лёгкости (слабейший 🟢 90%, 👹 50%, 🗿 20%);
 * - слабейший — наблюдатель: видит по горизонтали/вертикали сквозь
 *   только траву, идёт к игроку; потеряв из виду — идёт к клетке
 *   последнего контакта;
 * - вход врага в клетку игрока (или игрока во врага) — мгновенный
 *   переход в бой; победа — возврат на то же поле и место.
 */
export class MapTestScene extends Phaser.Scene {
  private world!: World;
  private seed = 12345;
  private fieldNum = 1;
  private player: WorldPos = { col: 0, row: 0 };
  private moves = 0;
  private bumps = 0;
  private visits = new Set<string>();

  private fieldEnemies: FieldEnemy[] = [];
  private enemyViews = new Map<number, Phaser.GameObjects.Image | Phaser.GameObjects.Text>();
  private merchantView: Phaser.GameObjects.Text | null = null;
  private playerHp = PLAYER_MAX_HP;
  private readonly playerMaxHp = PLAYER_MAX_HP;
  private combatLock = false;

  /** Прогресс забега: монеты + owned-способности + звёзды (источник — registry). */
  private progress: PlayerProgressData = defaultProgress();
  /** Текущие предложения торговца: 1-й ряд — улучшения, 2-й ряд — новые. */
  private shopOffers: ShopOffers = { upgrades: [], news: [] };
  private shopOpen = false;
  private shopOverlay: Phaser.GameObjects.Container | null = null;

  private gridLayer: Phaser.GameObjects.Container | null = null;
  private playerImg: Phaser.GameObjects.Image | null = null;
  private playerFallback: Phaser.GameObjects.Text | null = null;
  private playerMark: Phaser.GameObjects.Arc | null = null;
  private infoText!: Phaser.GameObjects.Text;
  private posText!: Phaser.GameObjects.Text;
  private logText!: Phaser.GameObjects.Text;
  private cell = 40;
  private originX = 0;
  private originY = 0;
  private revealPlaying = false;
  private revealId = 0;
  private revealCfg: RevealConfig = { ...DEFAULT_REVEAL };
  private explanationPlaying = false;
  private explanationLayer: Phaser.GameObjects.Container | null = null;
  private explanationHighlight: Phaser.GameObjects.Graphics | null = null;
  private explanationText: Phaser.GameObjects.Text | null = null;

  /** Граф полей (миникарта). Каждый узел = одно поле. */
  private dungeon: DungeonGraph | null = null;
  /** Сохранённые миры/враги посещённых узлов для возврата назад. */
  private nodeCache = new Map<string, { world: World; fieldEnemies: FieldEnemy[] }>();
  private minimap: DungeonMinimap | null = null;

  constructor() {
    super('MapTest');
  }

  preload(): void {
    this.load.image(HERO_TEXTURE, 'assets/characters/maps/Player/Herro.png');
    for (const e of ENEMY_CATALOG) {
      const key = enemyMapKey(e.id);
      const file = e.mapTexture || e.texture || e.id;
      this.load.image(key, `assets/characters/maps/Enemy/${file}.png`);
    }
  }

  private fitToCell(img: Phaser.GameObjects.Image, ratio = 0.9): void {
    const source = this.textures.get(img.texture.key).getSourceImage() as { width: number; height: number };
    img.setScale((this.cell * ratio) / Math.max(source.width || 1, source.height || 1));
  }

  create(data?: { fromCombat?: boolean; seed?: number; explainGeneration?: boolean }): void {
    const { width } = this.scale;
    this.cameras.main.setBackgroundColor('#000000');
    this.cameras.main.fadeIn(200, 0, 0, 0);
    this.revealCfg = parseRevealConfig(revealDef);
    this.combatLock = false;
    this.shopOpen = false;
    this.shopOverlay = null;
    this.enemyViews = new Map();
    this.merchantView = null;
    this.nodeCache = new Map();
    this.ensureDungeon();

    let restoredMsg: string | null = null;
    if (data?.fromCombat) {
      restoredMsg = this.tryRestoreAfterCombat();
    }
    if (restoredMsg === null) {
      this.enterDungeonStart();
    }
    // Прогресс/офферы уже загружены (restore) или сброшены (fresh-старт).
    this.loadProgressAndOffers();

    const title = this.add
      .text(width / 2, 10, '🧪 TEST: лабиринт — движение', {
        fontSize: '22px',
        color: '#ffd76a',
        fontStyle: 'bold',
      })
      .setOrigin(0.5, 0);
    thicken(title, 4);

    this.infoText = this.add
      .text(width / 2, 40, '', { fontSize: '15px', color: '#cfe8cf', align: 'center' })
      .setOrigin(0.5, 0);
    this.posText = this.add
      .text(width / 2, 78, '', { fontSize: '17px', color: '#9aff9a', fontStyle: 'bold' })
      .setOrigin(0.5, 0);

    this.drawWorld();

    this.minimap?.destroy();
    this.minimap = new DungeonMinimap(this);
    if (this.dungeon) this.minimap.refresh(this.dungeon);

    const { height } = this.scale;
    this.logText = this.add
      .text(width / 2, height - 188, 'Свайп / стрелки / WASD / тап по соседней клетке', {
        fontSize: '16px',
        color: '#cfe8cf',
        align: 'center',
        wordWrap: { width: width - 40 },
      })
      .setOrigin(0.5, 0);

    this.buildDPad();
    this.buildBottomButtons();
    this.bindInput();
    this.refreshHud(restoredMsg ?? 'Готов. Спавн в центре.');
    applyThickFont(this);
    if (data?.explainGeneration) this.startGenerationExplanation();
    // Победа на клетке торговца — открыть магазин после появления поля.
    if (this.pendingShopOpen) {
      this.pendingShopOpen = false;
      const delay = (this.revealCfg.totalMs ?? 0) + 150;
      this.time.delayedCall(delay, () => {
        if (!this.combatLock && !this.shopOpen && isOnMerchant(this.world, this.player)) {
          this.openShop();
        }
      });
    }
  }

  // ---------- Противники ----------

  /** Расставить полевых врагов: слот 0 — слабейший наблюдатель, остальные — ролл по spawnWeight. */
  private spawnFieldEnemies(): void {
    const ids = pickEnemyIds(this.world.enemies.length || FIELD_CONFIG.enemyCount);
    this.fieldEnemies = createFieldEnemies(this.world.enemies, ids, moveChances());
  }

  private aliveEnemies(): FieldEnemy[] {
    return this.fieldEnemies.filter((e) => e.alive);
  }

  /** Статус наблюдателя для HUD/лога. */
  private chaserNote(): string {
    const chaser = this.fieldEnemies.find((e) => e.alive && e.role === 'chaser');
    if (!chaser) return '';
    const emoji = enemyEmoji(chaser.enemyId);
    if (hasLineOfSight(this.world, chaser, this.player)) return `${emoji} видит тебя 👀`;
    if (chaser.lastSeen) return `${emoji} идёт к (${chaser.lastSeen.col},${chaser.lastSeen.row})`;
    return `${emoji} патруль`;
  }

  /** Стоит ли открыть магазин после возврата из боя (победа на клетке торговца). */
  private pendingShopOpen = false;

  // ---------- Прогресс (монеты/способности/звёзды) + офферы ----------

  /** Загрузить прогресс и офферы из registry (единый источник, бой уже зачислил монеты). */
  private loadProgressAndOffers(): void {
    this.progress = loadProgress(this.registry.get('playerProgress'));
    this.registry.set('playerProgress', cloneProgress(this.progress));
    const rawOffers = this.registry.get('shopOffers') as ShopOffers | undefined;
    this.shopOffers = sanitizeOffers(ALL_COMBOS, this.progress, rawOffers);
    this.registry.set('shopOffers', { ...this.shopOffers, upgrades: [...this.shopOffers.upgrades], news: [...this.shopOffers.news] });
  }

  private saveProgress(): void {
    this.registry.set('playerProgress', cloneProgress(this.progress));
    this.registry.set('shopOffers', { upgrades: [...this.shopOffers.upgrades], news: [...this.shopOffers.news] });
  }

  /** Новый забег: сбросить монеты/способности/офферы. */
  private resetProgress(): void {
    this.progress = defaultProgress();
    this.shopOffers = rollShopOffers(ALL_COMBOS, this.progress);
    this.saveProgress();
  }

  private saveMapState(): void {
    // Текущий узел — в кэш чтобы возврат назад восстановил мир и врагов.
    if (this.dungeon) {
      this.nodeCache.set(this.dungeon.currentId, {
        world: this.world,
        fieldEnemies: this.fieldEnemies.map((e) => ({
          ...e,
          lastSeen: e.lastSeen ? { ...e.lastSeen } : null,
        })),
      });
    }
    const cache: Record<string, { world: World; fieldEnemies: FieldEnemy[] }> = {};
    for (const [id, v] of this.nodeCache) {
      cache[id] = {
        world: v.world,
        fieldEnemies: v.fieldEnemies.map((e) => ({
          ...e,
          lastSeen: e.lastSeen ? { ...e.lastSeen } : null,
        })),
      };
    }
    const state: SavedMapState = {
      world: this.world,
      player: { ...this.player },
      fieldEnemies: this.fieldEnemies.map((e) => ({
        ...e,
        lastSeen: e.lastSeen ? { ...e.lastSeen } : null,
      })),
      playerHp: this.playerHp,
      moves: this.moves,
      bumps: this.bumps,
      visits: [...this.visits],
      seed: this.seed,
      fieldNum: this.fieldNum,
      dungeon: this.dungeon ? serializeDungeon(this.dungeon) : null,
      nodeCache: cache,
    };
    this.registry.set('mapState', state);
  }

  /**
   * Восстановить то же поле после боя. Возвращает сообщение для HUD
   * или null если восстанавливать нечего (обычный fresh-старт).
   * Монеты уже зачислены сценой боя в registry-прогресс — здесь только поле/враги/HP.
   */
  private tryRestoreAfterCombat(): string | null {
    const state = this.registry.get('mapState') as SavedMapState | undefined;
    const result = this.registry.get('duelResult') as DuelResult | undefined;
    if (!state || !result) return null;
    this.registry.remove('duelResult');
    // mapState оставляем — пригодится для следующего боя на этом же поле.

    this.world = state.world;
    this.seed = state.seed;
    this.fieldNum = state.fieldNum;
    this.moves = state.moves;
    this.bumps = state.bumps;
    this.visits = new Set(state.visits);
    this.fieldEnemies = state.fieldEnemies.map((e) => ({ ...e, enemyId: normalizeEnemyId(e.enemyId) }));
    // Данж и кэш узлов: без них миникарта и возврат назад невозможны.
    this.ensureDungeon();
    if (this.dungeon && state.dungeon) restoreDungeonState(this.dungeon, state.dungeon);
    ensureWorldMerchant(this.world, this.dungeon?.nodes.get(this.dungeon.currentId)?.type === 'shop');
    this.nodeCache = new Map();
    if (state.nodeCache) {
      for (const [id, v] of Object.entries(state.nodeCache)) {
        ensureWorldMerchant(v.world, this.dungeon?.nodes.get(id)?.type === 'shop');
        this.nodeCache.set(id, {
          world: v.world,
          fieldEnemies: v.fieldEnemies.map((e) => ({ ...e, enemyId: normalizeEnemyId(e.enemyId) })),
        });
      }
    }

    const foe = this.fieldEnemies.find((e) => e.uid === result.uid);
    if (result.victory) {
      if (foe) {
        foe.alive = false;
        foe.lastSeen = null;
      }
      this.player = { ...state.player };
      this.playerHp = Math.max(1, result.playerHpLeft);
      const left = this.aliveEnemies().length;
      const coinsNote = result.coinsEarned ? ` +${result.coinsEarned}💰` : '';
      // Победа на клетке торговца — после отрисовки откроем магазин.
      this.pendingShopOpen = isOnMerchant(this.world, this.player);
      const shopNote = this.pendingShopOpen ? ' 🏪 Торговец ждёт — открываю магазин...' : '';
      return `🏆 ${foe ? enemyEmoji(foe.enemyId) : '💀'} повержен${coinsNote}! Ты на той же клетке (${this.player.col},${this.player.row}), ❤️ ${this.playerHp}. Осталось врагов: ${left}.${shopNote}`;
    }
    // Поражение: враг остаётся, игрок откатывается на спавн с полным HP
    // чтобы не было мгновенного повторного боя на той же клетке.
    this.player = { ...this.world.spawn };
    this.visits.add(`${this.player.col},${this.player.row}`);
    this.playerHp = this.playerMaxHp;
    return `💀 Поражение от ${foe ? enemyEmoji(foe.enemyId) : '💀'}... Откат на спавн (${this.player.col},${this.player.row}), ❤️ восстановлено. Враг ждёт!`;
  }

  /** Мгновенный переход к сцене сражения с этим противником. */
  private startDuel(foe: FieldEnemy, reason: string): void {
    if (this.combatLock) return;
    this.combatLock = true;
    this.saveMapState();
    sfx.hit();
    const entry = enemyById(foe.enemyId);
    const dmg = entry ? scaledDamage(entry, this.fieldNum) : undefined;
    this.cameras.main.flash(180, 255, 60, 60);
    this.logText?.setText(`${reason} — ⚔️ БОЙ с ${enemyEmoji(foe.enemyId)}!`).setColor('#ff9a9a');
    this.time.delayedCall(350, () => {
      this.scene.start('CombatLab', {
        duel: {
          uid: foe.uid,
          enemyId: foe.enemyId,
          playerHp: this.playerHp,
          playerMaxHp: this.playerMaxHp,
          damageOverride: dmg,
          attackType: entry?.attackType,
          fieldNum: this.fieldNum,
        },
      });
    });
  }

  // ---------- Отрисовка ----------

  /**
   * Построение поля + эффект появления волной ~2с.
   * Волна идёт от стороны входа (вошли снизу — клетки затухают снизу вверх),
   * при обычной загрузке — от центра. Ввод блокируется до конца эффекта.
   */
  private drawWorld(reveal: RevealOrigin = 'center'): void {
    const { width, height } = this.scale;
    this.tweens.killAll();
    this.gridLayer?.destroy(true);
    this.gridLayer = this.add.container(0, 0);
    this.enemyViews = new Map();
    this.playerImg = null;
    this.playerFallback = null;
    this.playerMark = null;
    const revealId = ++this.revealId;
    this.revealPlaying = true;

    const topReserve = FIELD_CONFIG.topReservePx;
    const bottomReserve = FIELD_CONFIG.bottomReservePx;
    const availW = width - 24;
    const availH = height - topReserve - bottomReserve;
    this.cell = Math.max(
      FIELD_CONFIG.minCellPx,
      Math.floor(Math.min(availW / this.world.cols, availH / this.world.rows)),
    );
    const gridW = this.cell * this.world.cols;
    const gridH = this.cell * this.world.rows;
    this.originX = Math.round((width - gridW) / 2);
    this.originY = Math.round(topReserve + (availH - gridH) / 2);

    // Порядок появления: чем меньше, тем раньше (сторона входа first).
    // waveFrom=center в конфиге — всегда волной от центра.
    const radial = reveal === 'center' || this.revealCfg.waveFrom === 'center';
    const orderOf = (c: number, r: number): number => {
      if (radial) return Math.abs(c - this.player.col) + Math.abs(r - this.player.row);
      switch (reveal) {
        case 'N':
          return r;
        case 'S':
          return this.world.rows - 1 - r;
        case 'W':
          return c;
        case 'E':
        default:
          return this.world.cols - 1 - c;
      }
    };
    interface RevealItem {
      obj: { alpha: number; y: number };
      alpha: number;
      y: number;
      order: number;
    }
    const items: RevealItem[] = [];
    const arrows: Phaser.GameObjects.Text[] = [];
    const isShopField = this.dungeon?.nodes.get(this.dungeon.currentId)?.type === 'shop';
    const drop = this.revealCfg.dropPx;
    const track = (obj: { alpha: number; y: number }, c: number, r: number, a = 1): void => {
      const y = obj.y;
      obj.y = y - drop;
      obj.alpha = 0;
      items.push({ obj, alpha: a, y, order: orderOf(c, r) });
    };

    for (let r = 0; r < this.world.rows; r++) {
      for (let c = 0; c < this.world.cols; c++) {
        const cell = this.world.cells[r][c];
        if (cell.terrain === 'void') continue; // чёрный фон как на картинке
        const x = this.originX + c * this.cell;
        const y = this.originY + r * this.cell;
        const fill = isShopField
          ? cell.terrain === 'grass'
            ? 0x4caf50
            : cell.terrain === 'water'
              ? 0x318b78
              : 0x1b5e20
          : cell.terrain === 'grass'
            ? 0x4a8f3c
            : cell.terrain === 'water'
              ? 0x3f6fd1
              : 0x14301a;
        const rect = this.add.rectangle(x, y, this.cell - 1, this.cell - 1, fill);
        rect.setOrigin(0, 0).setStrokeStyle(1, 0x0a1a0c, 0.8);
        rect.setInteractive({ useHandCursor: false });
        rect.on('pointerup', () => this.onTapCell(c, r));
        this.gridLayer.add(rect);
        track(rect, c, r);

        const cx = x + this.cell / 2;
        const cy = y + this.cell / 2;
        const emojiSize = Math.max(14, Math.floor(this.cell * 0.55));

        if (cell.terrain === 'forest') {
          const t = this.add.text(cx, cy, '🌲', { fontSize: `${emojiSize}px` }).setOrigin(0.5);
          this.gridLayer.add(t);
          track(t, c, r);
        } else if (cell.terrain === 'water') {
          const rock = this.add.text(cx + this.cell * 0.16, cy + this.cell * 0.1, '🪨', {
            fontSize: `${Math.floor(emojiSize * 0.8)}px`,
          }).setOrigin(0.5);
          const reeds = this.add.text(cx - this.cell * 0.2, cy - this.cell * 0.12, '🌾', {
            fontSize: `${Math.floor(emojiSize * 0.8)}px`,
          }).setOrigin(0.5);
          this.gridLayer.add(rock);
          this.gridLayer.add(reeds);
          track(rock, c, r);
          track(reeds, c, r);
        } else if (cell.decor !== 'none' && DECOR_EMOJI[cell.decor]) {
          const d = this.add
            .text(cx, cy + this.cell * 0.18, DECOR_EMOJI[cell.decor], {
              fontSize: `${Math.floor(emojiSize * 0.7)}px`,
            })
            .setOrigin(0.5)
            .setAlpha(0.95);
          this.gridLayer.add(d);
          track(d, c, r, 0.95);
        }

        // Маркер выхода — коричневая стрелка у края клетки.
        if (cell.exit) {
          const arrow = this.add
            .text(cx, cell.exit === 'N' ? y + 8 : cell.exit === 'S' ? y + this.cell - 8 : cy, EXIT_ARROW[cell.exit], {
              fontSize: '14px',
              color: '#c98a4b',
              fontStyle: 'bold',
            })
            .setOrigin(0.5);
          this.gridLayer.add(arrow);
          if (cell.exit === 'W') arrow.setPosition(x + 8, cy);
          if (cell.exit === 'E') arrow.setPosition(x + this.cell - 8, cy);
          track(arrow, c, r);
          arrows.push(arrow);
        }
      }
    }

    // Полевые враги: map-спрайт колоды, фолбэк — эмодзи.
    for (const e of this.aliveEnemies()) {
      const { x, y } = this.cellCenter(e);
      const key = enemyMapKey(e.enemyId);
      const dy = e.role === 'chaser' ? -this.cell * 0.12 : -this.cell * 0.08;
      if (this.textures.exists(key)) {
        const img = this.add.image(x, y + dy, key);
        this.fitToCell(img, 0.85);
        this.gridLayer.add(img);
        this.enemyViews.set(e.uid, img);
        track(img, e.col, e.row);
      } else {
        const t = this.add
          .text(x, y + dy, enemyEmoji(e.enemyId), { fontSize: `${Math.floor(this.cell * 0.55)}px` })
          .setOrigin(0.5);
        this.gridLayer.add(t);
        this.enemyViews.set(e.uid, t);
        track(t, e.col, e.row);
      }
    }

    // Торговец 🏪: отдельная клетка травы, встаёшь — открывается магазин.
    try {
      const m = this.world.merchant;
      if (m) {
        const { x: mx, y: my } = this.cellCenter(m);
        const merchantTile = this.add.rectangle(
          this.originX + m.col * this.cell,
          this.originY + m.row * this.cell,
          this.cell - 1,
          this.cell - 1,
          isShopField ? 0x86b85c : 0x8a6d2b,
          0.7,
        );
        merchantTile.setOrigin(0, 0).setStrokeStyle(2, isShopField ? 0xe4ff9a : 0xffd76a, 1);
        this.gridLayer.add(merchantTile);
        track(merchantTile, m.col, m.row);
        const stall = this.add.circle(
          mx,
          my,
          this.cell * 0.42,
          isShopField ? 0x8bcf65 : 0x8a6d2b,
          0.35,
        );
        stall.setStrokeStyle(2, isShopField ? 0xd8ff9a : 0xffd76a, 0.9);
        this.gridLayer.add(stall);
        track(stall, m.col, m.row);
        const mt = this.add
          .text(mx, my - this.cell * 0.05, MERCHANT_EMOJI, { fontSize: `${Math.floor(this.cell * 0.6)}px` })
          .setOrigin(0.5);
        this.gridLayer.add(mt);
        this.merchantView = mt;
        track(mt, m.col, m.row);
      } else {
        this.merchantView = null;
      }
    } catch {
      this.merchantView = null;
    }

    // Игрок поверх.
    const { x: px, y: py } = this.cellCenter(this.player);
    this.playerMark = this.add.circle(px, py, this.cell * 0.44, 0xffd76a, 0.22);
    this.playerMark.setStrokeStyle(2, 0xffd76a, 0.95);
    this.gridLayer.add(this.playerMark);
    track(this.playerMark, this.player.col, this.player.row);
    if (this.textures.exists(HERO_TEXTURE)) {
      this.playerImg = this.add.image(px, py, HERO_TEXTURE);
      const t = this.textures.get(HERO_TEXTURE).getSourceImage() as {
        width: number;
        height: number;
      };
      const target = this.cell * 0.9;
      this.playerImg.setScale(target / Math.max(t.width || 1, t.height || 1));
      this.gridLayer.add(this.playerImg);
      track(this.playerImg, this.player.col, this.player.row);
    } else {
      this.playerFallback = this.add
        .text(px, py, '🧙', { fontSize: `${Math.floor(this.cell * 0.65)}px` })
        .setOrigin(0.5);
      this.gridLayer.add(this.playerFallback);
      track(this.playerFallback, this.player.col, this.player.row);
    }

    // Раскладка волны: сдвиг по порядку + проявление/падение каждой клетки.
    // Время и высота — из reveal_config.json (totalMs, fadeMs, dropPx).
    const totalMs = this.revealCfg.totalMs;
    const fadeMs = this.revealCfg.fadeMs;
    const ease = this.revealCfg.dropEase;
    let maxOrder = 0;
    for (const it of items) maxOrder = Math.max(maxOrder, it.order);
    const sweepMs = totalMs - fadeMs;
    const stagger = maxOrder > 0 ? sweepMs / maxOrder : 0;
    for (const it of items) {
      this.tweens.add({
        targets: it.obj,
        alpha: it.alpha,
        y: it.y,
        duration: fadeMs,
        delay: it.order * stagger,
        ease,
      });
    }
    // Мигание стрелок стартует после появления поля.
    for (const a of arrows) {
      this.tweens.add({
        targets: a,
        alpha: 0.35,
        duration: 600,
        yoyo: true,
        repeat: -1,
        delay: totalMs,
      });
    }
    this.time.delayedCall(totalMs + 60, () => {
      if (revealId === this.revealId) this.revealPlaying = false;
    });
  }

  private cellCenter(p: WorldPos): { x: number; y: number } {
    return {
      x: this.originX + p.col * this.cell + this.cell / 2,
      y: this.originY + p.row * this.cell + this.cell / 2,
    };
  }

  // ---------- Ввод ----------

  private bindInput(): void {
    const swipe = new SwipeInput(this, { thresholdPx: 24 });
    swipe.onSwipe((dir) => this.move(dir));

    this.input.keyboard?.on('keydown-UP', () => this.move('Up'));
    this.input.keyboard?.on('keydown-DOWN', () => this.move('Down'));
    this.input.keyboard?.on('keydown-LEFT', () => this.move('Left'));
    this.input.keyboard?.on('keydown-RIGHT', () => this.move('Right'));
    this.input.keyboard?.on('keydown-W', () => this.move('Up'));
    this.input.keyboard?.on('keydown-S', () => this.move('Down'));
    this.input.keyboard?.on('keydown-A', () => this.move('Left'));
    this.input.keyboard?.on('keydown-D', () => this.move('Right'));
    this.input.keyboard?.on('keydown-R', () => this.regenerate());
  }

  private onTapCell(col: number, row: number): void {
    const dc = col - this.player.col;
    const dr = row - this.player.row;
    if (Math.abs(dc) + Math.abs(dr) !== 1) return;
    const dir: SwipeDir = dc === 1 ? 'Right' : dc === -1 ? 'Left' : dr === 1 ? 'Down' : 'Up';
    this.move(dir);
  }

  /** Один свайп = ровно одна клетка, ходибельна только трава. */
  private move(dir: SwipeDir): void {
    // Пока поле появляется (волна ~2с), открыт бой или магазин — ввод игнорируется.
    if (this.revealPlaying || this.explanationPlaying || this.combatLock || this.shopOpen) return;
    // Стоим на выходе и шагаем наружу — переход на следующее поле.
    const cur = this.world.cells[this.player.row][this.player.col];
    if (cur.exit && dir === EXIT_OUTWARD[cur.exit]) {
      this.advance(cur.exit);
      return;
    }
    const res = tryStepWorld(this.world, this.player, dir);
    if (res.moved) {
      this.player = res.next;
      this.moves++;
      this.visits.add(`${this.player.col},${this.player.row}`);
      sfx.swipe();
      const { x, y } = this.cellCenter(this.player);
      this.playerMark?.setPosition(x, y);
      if (this.playerImg) {
        this.tweens.add({ targets: this.playerImg, x, y, duration: 110, ease: 'Quad.easeOut' });
      } else {
        this.playerFallback?.setPosition(x, y);
      }
      // 1) Игрок сам шагнул на врага — бой немедленно.
      const steppedOn = enemyOnPlayer(this.fieldEnemies, this.player);
      if (steppedOn) {
        this.refreshHud(`Шаг ${SWIPE_ARROW[dir]} → (${this.player.col}, ${this.player.row}) • ${enemyEmoji(steppedOn.enemyId)} засада!`);
        this.startDuel(steppedOn, `Ты шагнул на ${enemyEmoji(steppedOn.enemyId)} (${this.player.col},${this.player.row})`);
        return;
      }
      // 2) Ход врагов — только вслед за успешным ходом игрока.
      const { entered, moved } = moveEnemiesAfterPlayer(this.world, this.fieldEnemies, this.player);
      for (const e of moved) {
        const view = this.enemyViews.get(e.uid);
        if (view) {
          const { x: ex, y: ey } = this.cellCenter(e);
          this.tweens.add({ targets: view, x: ex, y: ey, duration: 140, ease: 'Quad.easeOut' });
        }
      }
      const cell = this.world.cells[this.player.row][this.player.col];
      let msg = `Шаг ${SWIPE_ARROW[dir]} → (${this.player.col}, ${this.player.row})`;
      if (cell.exit) {
        const locked = this.aliveEnemies().length > 0;
        msg += locked
          ? ` • выход ${cell.exit} 🔒 закрыт — убей всех врагов!`
          : ` • выход ${cell.exit} — шагни ${SWIPE_ARROW[EXIT_OUTWARD[cell.exit]]} для перехода`;
      }
      if (moved.length > 0) {
        const parts = moved.map((e) => `${enemyEmoji(e.enemyId)}→(${e.col},${e.row})`);
        msg += ` • враги: ${parts.join(' ')}`;
      }
      const note = this.chaserNote();
      if (note) msg += ` • ${note}`;
      const near = adjacentEnemies(this.fieldEnemies, this.player);
      if (near.length > 0 && !entered) {
        msg += ` • ⚠ ${near.map((e) => enemyEmoji(e.enemyId)).join('')} рядом!`;
      }
      if (entered) {
        this.refreshHud(msg);
        this.startDuel(entered, `${enemyEmoji(entered.enemyId)} вошёл в твою клетку (${this.player.col},${this.player.row})`);
        return;
      }
      // 3) Клетка торговца — открыть магазин (после хода врагов, если не было боя).
      if (isOnMerchant(this.world, this.player)) {
        this.refreshHud(`${msg} • 🏪 Торговец! Открываю магазин...`);
        this.openShop();
        return;
      }
      this.refreshHud(msg);
    } else {
      this.bumps++;
      sfx.wrong();
      this.cameras.main.shake(60, 0.003);
      const why =
        res.reason === 'water'
          ? 'вода — туда нельзя'
          : res.reason === 'forest'
            ? 'лес 🌲 — туда нельзя'
            : res.reason === 'void'
              ? 'пустота — туда нельзя'
              : 'край мира';
      this.refreshHud(`⛔ ${SWIPE_ARROW[dir]}: ${why}`);
    }
  }

  /** Новое случайное поле: генератор (размеры и враги из field_config.json). Seed берёт из this.seed. */
  private loadWorld(): void {
    const current = this.dungeon ? currentNode(this.dungeon) : null;
    const isShopField = current?.type === 'shop';
    const fieldConfig = isShopField ? SHOP_FIELD : FIELD_CONFIG;
    this.world = generateWorld({
      seed: this.seed,
      cols: fieldConfig.cols,
      rows: fieldConfig.rows,
      enemyCount: fieldConfig.enemyCount,
      maxGrassMin: fieldConfig.maxGrassMin,
      maxGrassSpan: fieldConfig.maxGrassSpan,
      merchant: isShopField,
      // Двери совпадают со связями текущей комнаты данжа.
      exits: this.dungeon ? linkedDirs(currentNode(this.dungeon)) : undefined,
    });
    ensureWorldMerchant(this.world, isShopField);
  }

  // ---------- Подземелье (граф полей + миникарта) ----------

  private freshDungeon(seed: number): DungeonGraph | null {
    try {
      return generateDungeon({ seed });
    } catch {
      // Используем JSON-фикстуру как детерминированный fallback.
      try {
        return parseDungeon(dungeonTestJson);
      } catch {
        return null;
      }
    }
  }

  /** Данж на текущий забег; при отсутствии — сгенерировать. */
  private ensureDungeon(): void {
    if (this.dungeon) return;
    this.dungeon = this.freshDungeon(this.seed);
  }

  /** Fresh-старт забега: стартовый узел данжа, спавн в центре (без отрисовки — её делает create). */
  private enterDungeonStart(): void {
    // Новый забег — монеты/способности сбрасываются.
    this.resetProgress();
    this.pendingShopOpen = false;
    if (!this.dungeon) {
      this.loadWorld();
      this.player = { ...this.world.spawn };
      this.moves = 0;
      this.bumps = 0;
      this.fieldNum = 1;
      this.playerHp = this.playerMaxHp;
      this.visits = new Set([`${this.player.col},${this.player.row}`]);
      this.spawnFieldEnemies();
      return;
    }
    this.nodeCache = new Map();
    const start = currentNode(this.dungeon);
    this.seed = start.seed;
    this.loadWorld();
    this.player = { ...this.world.spawn };
    this.moves = 0;
    this.bumps = 0;
    this.fieldNum = 1;
    this.playerHp = this.playerMaxHp;
    this.combatLock = false;
    this.visits = new Set([`${this.player.col},${this.player.row}`]);
    this.spawnFieldEnemies();
  }

  /**
   * Загрузить мир узла: из кэша (возврат назад — мир и враги как оставили)
   * или свежий по seed узла. Игрок всегда появляется на входе:
   * entry=null — спавн в центре (старт), иначе зеркальный выход.
   */
  private loadNodeWorld(nodeId: string, entry: ExitDir | null): void {
    const node = this.dungeon?.nodes.get(nodeId);
    const seed = node?.seed ?? this.seed;
    const cached = this.nodeCache.get(nodeId);
    if (cached) {
      ensureWorldMerchant(cached.world, node?.type === 'shop');
      this.world = cached.world;
      this.fieldEnemies = cached.fieldEnemies.map((e) => ({
        ...e,
        lastSeen: e.lastSeen ? { ...e.lastSeen } : null,
      }));
    } else {
      this.seed = seed;
      this.loadWorld();
      this.spawnFieldEnemies();
    }
    this.seed = seed;
    this.player = entry ? { ...(this.world.exits[entry] ?? this.world.spawn) } : { ...this.world.spawn };
    this.moves = 0;
    this.bumps = 0;
    this.combatLock = false;
    this.visits = new Set([`${this.player.col},${this.player.row}`]);
    if (this.dungeon) this.fieldNum = this.dungeon.visited.size;
  }

  private resetPlayer(msg: string, reveal: RevealOrigin = 'center'): void {
    this.closeShop(true);
    this.player = { ...this.world.spawn };
    this.moves = 0;
    this.bumps = 0;
    this.fieldNum = this.dungeon ? this.dungeon.visited.size : 1;
    this.playerHp = this.playerMaxHp;
    this.combatLock = false;
    this.visits = new Set([`${this.player.col},${this.player.row}`]);
    this.spawnFieldEnemies();
    this.drawWorld(reveal);
    this.minimapRefresh();
    this.refreshHud(msg);
    applyThickFont(this);
  }

  private minimapRefresh(): void {
    if (this.dungeon && this.minimap) this.minimap.refresh(this.dungeon);
  }

  /**
   * Переход через выход на соседнее поле графа.
   * Появление — через зеркальный выход: вышли через N — встали на S.
   * Блокировка абсолютная: пока жив хоть один враг — нельзя ни вперёд, ни назад.
   */
  private advance(fromDir: ExitDir): void {
    if (!this.dungeon) {
      this.advanceLegacyRandom(fromDir);
      return;
    }
    const alive = this.aliveEnemies().length;
    if (alive > 0) {
      sfx.wrong();
      this.cameras.main.shake(60, 0.003);
      this.refreshHud(
        `⛔ Выход ${fromDir} закрыт — убей всех врагов! Осталось: ${alive}.`,
      );
      return;
    }
    const next = neighborInDir(this.dungeon, this.dungeon.currentId, fromDir);
    if (!next) {
      this.bumps++;
      sfx.wrong();
      this.cameras.main.shake(60, 0.003);
      this.refreshHud(`⛔ Выход ${fromDir} ведёт в тупик — на карте нет поля.`);
      return;
    }
    this.goToNode(next.id, fromDir);
  }

  /** Переход на узел графа с сохранением текущего мира в кэш для возврата. */
  private goToNode(nextId: string, fromDir: ExitDir): void {
    if (!this.dungeon) return;
    this.nodeCache.set(this.dungeon.currentId, {
      world: this.world,
      fieldEnemies: this.fieldEnemies.map((e) => ({
        ...e,
        lastSeen: e.lastSeen ? { ...e.lastSeen } : null,
      })),
    });
    moveTo(this.dungeon, nextId);
    const entry = OPPOSITE_EXIT[fromDir];
    this.loadNodeWorld(nextId, entry);
    this.drawWorld(entry);
    this.minimapRefresh();
    sfx.perfect();
    this.cameras.main.flash(150, 255, 255, 255);
    let msg = `Переход ${fromDir} → поле ${nextId}, вход с ${entry}. ❤️ ${this.playerHp}/${this.playerMaxHp}.`;
    const onEnemy = enemyOnPlayer(this.fieldEnemies, this.player);
    if (onEnemy) {
      this.refreshHud(`${msg} • ${enemyEmoji(onEnemy.enemyId)} враг на входе!`);
      // Даём полю появиться (волна ~2с), затем сразу бой.
      this.combatLock = true;
      this.time.delayedCall(this.revealCfg.totalMs + 120, () => {
        this.combatLock = false;
        this.startDuel(onEnemy, `${enemyEmoji(onEnemy.enemyId)} ждал на входе (${this.player.col},${this.player.row})`);
      });
      applyThickFont(this);
      return;
    }
    msg += ` • ${this.chaserNote()}`;
    this.refreshHud(msg);
    applyThickFont(this);
  }

  /** Запасной путь без данжа (битый JSON): следующее случайное поле, seed+1. */
  private advanceLegacyRandom(fromDir: ExitDir): void {
    this.seed = (this.seed + 1) >>> 0;
    this.loadWorld();
    const entry = OPPOSITE_EXIT[fromDir];
    this.player = { ...(this.world.exits[entry] ?? this.world.spawn) };
    this.moves = 0;
    this.bumps = 0;
    this.fieldNum++;
    // HP persists between fields (один забег), враги — новые.
    this.combatLock = false;
    this.visits = new Set([`${this.player.col},${this.player.row}`]);
    this.spawnFieldEnemies();
    this.drawWorld(entry);
    sfx.perfect();
    this.cameras.main.flash(150, 255, 255, 255);
    let msg = `Переход ${fromDir} → seed ${this.seed}, вход с ${entry}. ❤️ ${this.playerHp}/${this.playerMaxHp}.`;
    const onEnemy = enemyOnPlayer(this.fieldEnemies, this.player);
    if (onEnemy) {
      this.refreshHud(`${msg} • ${enemyEmoji(onEnemy.enemyId)} враг на входе!`);
      // Даём полю появиться (волна ~2с), затем сразу бой.
      this.combatLock = true;
      this.time.delayedCall(this.revealCfg.totalMs + 120, () => {
        this.combatLock = false;
        this.startDuel(onEnemy, `${enemyEmoji(onEnemy.enemyId)} ждал на входе (${this.player.col},${this.player.row})`);
      });
      applyThickFont(this);
      return;
    }
    msg += ` • ${this.chaserNote()}`;
    this.refreshHud(msg);
    applyThickFont(this);
  }

  private regenerate(): void {
    if (this.combatLock || this.shopOpen) return;
    this.closeShop(true);
    const fresh = this.freshDungeon((this.seed + 1) >>> 0);
    if (fresh) {
      this.dungeon = fresh;
      this.nodeCache = new Map();
      const start = currentNode(fresh);
      this.seed = start.seed;
      this.loadWorld();
      this.resetProgress();
      this.resetPlayer(
        `Новый забег: ${fresh.nodes.size} полей. Старт: ${start.id} — видна только стартовая комната и соседи.`,
      );
      return;
    }
    this.seed = (this.seed + 1) >>> 0;
    this.loadWorld();
    this.resetPlayer(`Новое поле (seed ${this.seed}). Спавн в центре.`);
  }

  // ---------- HUD ----------

  private refreshHud(msg: string): void {
    const grass = countTerrain(this.world, 'grass');
    const water = countTerrain(this.world, 'water');
    const forest = countTerrain(this.world, 'forest');
    const ok = worldPlayable(this.world);
    const src = `GEN seed ${this.seed}`;
    const foes = this.aliveEnemies();
    const foeStr =
      foes.length > 0
        ? foes
            .map((e) => {
              const cat = enemyById(e.enemyId);
              const atk = cat ? `:${cat.attackType}${scaledDamage(cat, this.fieldNum)}` : '';
              const reward = cat ? coinsFor(cat, coinsForEnemy) : coinsForEnemy(e.enemyId);
              return `${enemyEmoji(e.enemyId)}(${Math.round(e.moveChance * 100)}%${atk}+${reward}💰)`;
            })
            .join(' ')
        : '—';
    const m = (this.world as Partial<World>).merchant;
    const merchNote = m ? ` • 🏪(${m.col},${m.row})` : '';
    const abilNote = ` • ✨${this.progress.owned.length}/${ALL_COMBOS.length}`;
    this.infoText.setText(
      `${this.world.cols}×${this.world.rows} • ${src}\nтрава ${grass} • вода ${water} • лес ${forest} • выходы: ${ok ? 'СВЯЗНЫ ✓' : 'НЕТ ✗'}\nвраги: ${foeStr} • ${this.chaserNote()}`,
    );
    this.posText.setText(
      `🧙 (${this.player.col}, ${this.player.row}) ❤️ ${this.playerHp}/${this.playerMaxHp} 💰 ${this.progress.coins}${abilNote} • поле ${this.dungeon ? this.dungeon.currentId : `#${this.fieldNum}`} • шагов: ${this.moves}${merchNote}`,
    );
    this.logText.setText(msg).setColor('#cfe8cf');
  }

  private dpadButton(x: number, y: number, label: string, dir: SwipeDir): void {
    const bg = this.add.rectangle(x, y, 64, 52, 0x2b3340).setStrokeStyle(2, 0x7c8aa5);
    bg.setInteractive({ useHandCursor: true });
    const t = this.add.text(x, y, label, { fontSize: '26px', color: '#ffffff' }).setOrigin(0.5);
    thicken(t, 3);
    bg.on('pointerup', () => this.move(dir));
  }

  private buildDPad(): void {
    const { width, height } = this.scale;
    const cy = height - 118;
    const cx = width / 2;
    this.dpadButton(cx, cy - 56, '↑', 'Up');
    this.dpadButton(cx - 70, cy, '←', 'Left');
    this.dpadButton(cx + 70, cy, '→', 'Right');
    this.dpadButton(cx, cy, '↓', 'Down');
  }

  private smallButton(x: number, y: number, w: number, label: string, cb: () => void): void {
    const bg = this.add.rectangle(x, y, w, 40, 0x444c5e).setStrokeStyle(2, 0xffffff, 0.6);
    bg.setInteractive({ useHandCursor: true });
    const t = this.add.text(x, y, label, { fontSize: '16px', color: '#ffffff' }).setOrigin(0.5);
    thicken(t, 3);
    bg.on('pointerup', cb);
  }

  private buildBottomButtons(): void {
    const { height } = this.scale;
    const y = height - 24;
    this.smallButton(65, y, 100, '↻ (R)', () => this.regenerate());
    this.smallButton(175, y, 100, '🏪', () => this.tryOpenShopManually());
    this.smallButton(285, y, 100, 'Меню', () => this.scene.start('Menu'));
    this.smallButton(430, y, 140, 'Бой →', () => this.scene.start('CombatLab'));
  }

  private startGenerationExplanation(): void {
    if (this.explanationPlaying || this.shopOpen || this.combatLock) return;
    this.explanationPlaying = true;
    this.revealPlaying = true;
    this.explanationLayer?.destroy(true);
    this.explanationLayer = this.add.container(0, 0).setDepth(120);
    this.explanationHighlight = this.add.graphics();
    this.explanationLayer.add(this.explanationHighlight);
    this.explanationText = this.add
      .text(this.scale.width / 2, 112, '', {
        fontSize: '18px',
        color: '#ffffff',
        backgroundColor: '#14101f',
        padding: { left: 12, right: 12, top: 8, bottom: 8 },
        align: 'center',
        wordWrap: { width: this.scale.width - 40 },
      })
      .setOrigin(0.5, 0);
    this.explanationLayer.add(this.explanationText);
    const skip = this.add
      .rectangle(this.scale.width / 2, this.scale.height - 188, 160, 38, 0x444c5e)
      .setStrokeStyle(2, 0xffffff, 0.8)
      .setInteractive({ useHandCursor: true });
    const skipText = this.add
      .text(this.scale.width / 2, this.scale.height - 188, 'Пропустить', {
        fontSize: '16px',
        color: '#ffffff',
      })
      .setOrigin(0.5);
    skip.on('pointerup', () => this.finishGenerationExplanation());
    this.explanationLayer.add([skip, skipText]);

    const phases = [
      {
        title: '1/6  Центр и выходы',
        detail: 'Генератор выбирает центр появления и по одному выходу на каждой стороне.',
        color: 0xffd76a,
        cells: Object.values(this.world.exits).concat([this.world.spawn]),
      },
      {
        title: '2/6  Связанные тропы',
        detail: 'От каждого выхода прокладывается путь к центру. Если путь не замкнулся, он ремонтируется.',
        color: 0x8be9fd,
        cells: this.grassCells(),
      },
      {
        title: '3/6  Вода и лес',
        detail: 'Свободные клетки становятся лесом, а одна-две внутренние области — водой.',
        color: 0x4f8cff,
        cells: this.terrainCells(['water', 'forest']),
      },
      {
        title: '4/6  Декор и выходы',
        detail: 'На поле добавляются стрелки выходов, цветы, пень и камыш.',
        color: 0xf4a261,
        cells: this.decorCells(),
      },
      {
        title: '5/6  Враги и торговец',
        detail: 'Враги ставятся на траву вдали от старта, затем выбирается безопасная клетка торговца.',
        color: 0xff6b6b,
        cells: this.actorCells(),
      },
      {
        title: '6/6  Проверка готовности',
        detail: 'Проверяется связность травы и доступность всех выходов. После этого поле готово.',
        color: 0x9aff9a,
        cells: this.grassCells(),
      },
    ];
    const stepMs = 1500;
    phases.forEach((phase, index) => {
      this.time.delayedCall(index * stepMs, () => {
        if (!this.explanationPlaying || !this.explanationText || !this.explanationHighlight) return;
        this.explanationText.setText(`${phase.title}\n${phase.detail}`);
        this.drawExplanationHighlight(phase.cells, phase.color);
      });
    });
    this.time.delayedCall(phases.length * stepMs, () => this.finishGenerationExplanation());
  }

  private finishGenerationExplanation(): void {
    this.explanationPlaying = false;
    this.revealPlaying = false;
    this.explanationLayer?.destroy(true);
    this.explanationLayer = null;
    this.explanationHighlight = null;
    this.explanationText = null;
    this.refreshHud('Готово: карта построена и проверена. Можно двигаться.');
  }

  private grassCells(): WorldPos[] {
    return this.terrainCells(['grass']);
  }

  private terrainCells(types: World['cells'][number][number]['terrain'][]): WorldPos[] {
    const allowed = new Set(types);
    const cells: WorldPos[] = [];
    for (let row = 0; row < this.world.rows; row++) {
      for (let col = 0; col < this.world.cols; col++) {
        if (allowed.has(this.world.cells[row][col].terrain)) cells.push({ col, row });
      }
    }
    return cells;
  }

  private decorCells(): WorldPos[] {
    const cells: WorldPos[] = [];
    for (let row = 0; row < this.world.rows; row++) {
      for (let col = 0; col < this.world.cols; col++) {
        const cell = this.world.cells[row][col];
        if (cell.exit || cell.decor !== 'none') cells.push({ col, row });
      }
    }
    return cells;
  }

  private actorCells(): WorldPos[] {
    const merchant = ensureWorldMerchant(this.world);
    return merchant ? [...this.world.enemies, merchant] : [...this.world.enemies];
  }

  private drawExplanationHighlight(cells: WorldPos[], color: number): void {
    const g = this.explanationHighlight;
    if (!g) return;
    g.clear();
    g.fillStyle(color, 0.18);
    g.lineStyle(2, color, 0.95);
    for (const cell of cells) {
      const x = this.originX + cell.col * this.cell;
      const y = this.originY + cell.row * this.cell;
      g.fillRect(x, y, this.cell - 1, this.cell - 1);
      g.strokeRect(x + 1, y + 1, this.cell - 3, this.cell - 3);
    }
  }

  // ---------- Магазин торговца ----------

  /** Ручное открытие с кнопки 🏪: только на клетке торговца. */
  private tryOpenShopManually(): void {
    if (this.shopOpen || this.combatLock || this.revealPlaying) return;
    if (isOnMerchant(this.world, this.player)) {
      this.openShop();
    } else {
      const m = (this.world as Partial<World>).merchant;
      sfx.wrong();
      this.refreshHud(
        m
          ? `🏪 Торговец на (${m.col},${m.row}) — встань на его клетку чтобы открыть магазин.`
          : '🏪 Торговца нет на этом поле.',
      );
    }
  }

  private effectLabel(c: ComboData): string {
    if (c.kind === 'damage') return `⚔${c.power}`;
    if (c.kind === 'buff_next') return `+${c.power}% след.`;
    return `+${c.power}HP`;
  }

  /** Открыть магазин (только на клетке торговца). */
  private openShop(): void {
    if (this.shopOpen) return;
    if (!isOnMerchant(this.world, this.player)) return;
    this.shopOpen = true;
    this.shopOffers = sanitizeOffers(ALL_COMBOS, this.progress, this.shopOffers);
    this.saveProgress();
    this.renderShop();
    sfx.perfect();
  }

  private closeShop(silent = false): void {
    if (!this.shopOpen && !this.shopOverlay) return;
    this.shopOpen = false;
    this.shopOverlay?.destroy(true);
    this.shopOverlay = null;
    if (!silent) {
      this.refreshHud(
        isOnMerchant(this.world, this.player)
          ? `🏪 Магазин закрыт. Ты на клетке торговца — нажми 🏪 чтобы открыть снова. 💰 ${this.progress.coins}.`
          : `🏪 Магазин закрыт. 💰 ${this.progress.coins}.`,
      );
      applyThickFont(this);
    }
  }

  private renderShop(): void {
    this.shopOverlay?.destroy(true);
    this.shopOverlay = null;
    const { width, height } = this.scale;
    const ov = this.add.container(0, 0).setDepth(200);
    const dim = this.add.rectangle(0, 0, width, height, 0x000000, 0.72).setOrigin(0, 0);
    dim.setInteractive();
    dim.on('pointerup', () => this.closeShop());
    ov.add(dim);

    const cx = width / 2;
    const panelW = width - 40;
    const panelH = 640;
    const panelY = 430;
    const panel = this.add.rectangle(cx, panelY, panelW, panelH, 0x141a24, 0.97);
    panel.setStrokeStyle(2, 0xffd76a, 0.9);
    ov.add(panel);

    const title = this.add
      .text(cx, 140, '🏪 ТОРГОВЕЦ', { fontSize: '24px', color: '#ffd76a', fontStyle: 'bold' })
      .setOrigin(0.5);
    thicken(title, 5);
    ov.add(title);

    const coins = this.add
      .text(cx, 168, `💰 ${this.progress.coins}   •   ✨ ${this.progress.owned.length}/${ALL_COMBOS.length} способностей`, {
        fontSize: '16px',
        color: '#ffd76a',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);
    thicken(coins, 3);
    ov.add(coins);

    // 1-й ряд — улучшение имеющихся (до 3 звёзд).
    const row1Label = this.add
      .text(cx, 198, '⬆ 1-й ряд — УЛУЧШИТЬ (есть)', { fontSize: '15px', color: '#9aff9a', fontStyle: 'bold' })
      .setOrigin(0.5);
    thicken(row1Label, 3);
    ov.add(row1Label);

    if (this.shopOffers.upgrades.length === 0) {
      const empty = this.add
        .text(cx, 300, this.progress.owned.length === 0 ? 'Нет способностей' : 'Всё прокачано ★★★!', {
          fontSize: '15px',
          color: '#7c8aa5',
        })
        .setOrigin(0.5);
      ov.add(empty);
    } else {
      this.shopOffers.upgrades.forEach((id, i) => {
        this.renderUpgradeCard(ov, id, i, this.shopOffers.upgrades.length);
      });
    }

    // 2-й ряд — новые способности.
    const row2Label = this.add
      .text(cx, 402, '✨ 2-й ряд — НОВЫЕ', { fontSize: '15px', color: '#9ab3ff', fontStyle: 'bold' })
      .setOrigin(0.5);
    thicken(row2Label, 3);
    ov.add(row2Label);

    if (this.shopOffers.news.length === 0) {
      const empty = this.add
        .text(cx, 505, 'Всё куплено! 🎉', { fontSize: '15px', color: '#7c8aa5' })
        .setOrigin(0.5);
      ov.add(empty);
    } else {
      this.shopOffers.news.forEach((id, i) => {
        this.renderNewCard(ov, id, i, this.shopOffers.news.length);
      });
    }

    // Кнопки: обновить предложения + закрыть.
    const rerollCost = SHOP_CONFIG.rerollCost;
    const canReroll = this.progress.coins >= rerollCost;
    const rerollBg = this.add
      .rectangle(cx - 110, 640, 200, 44, canReroll ? 0x2b6cb0 : 0x333a44)
      .setStrokeStyle(2, 0xffffff, 0.6)
      .setInteractive({ useHandCursor: true });
    const rerollTx = this.add
      .text(cx - 110, 640, `↻ Обновить ${rerollCost}💰`, { fontSize: '15px', color: '#ffffff' })
      .setOrigin(0.5);
    thicken(rerollTx, 3);
    rerollBg.on('pointerup', () => this.rerollShop());
    ov.add(rerollBg);
    ov.add(rerollTx);

    const closeBg = this.add
      .rectangle(cx + 115, 640, 150, 44, 0x444c5e)
      .setStrokeStyle(2, 0xffffff, 0.6)
      .setInteractive({ useHandCursor: true });
    const closeTx = this.add.text(cx + 115, 640, '✕ Закрыть', { fontSize: '15px', color: '#ffffff' }).setOrigin(0.5);
    thicken(closeTx, 3);
    closeBg.on('pointerup', () => this.closeShop());
    ov.add(closeBg);
    ov.add(closeTx);

    const hint = this.add
      .text(cx, 672, 'Тап по карте = купить/улучшить • ★ — уровень (макс ★★★)', {
        fontSize: '12px',
        color: '#7c8aa5',
        align: 'center',
        wordWrap: { width: panelW - 30 },
      })
      .setOrigin(0.5, 0);
    ov.add(hint);

    const comboHint = this.add
      .text(cx, 700, 'Улучшение: +40% к силе за ★ • Деньги — за убийства врагов', {
        fontSize: '12px',
        color: '#7c8aa5',
        align: 'center',
        wordWrap: { width: panelW - 30 },
      })
      .setOrigin(0.5, 0);
    ov.add(comboHint);

    this.shopOverlay = ov;
    applyThickFont(this);
  }

  private cardX(i: number, n: number): number {
    const { width } = this.scale;
    const gap = 160;
    const startX = width / 2 - ((n - 1) * gap) / 2;
    return startX + i * gap;
  }

  private renderUpgradeCard(ov: Phaser.GameObjects.Container, id: string, i: number, n: number): void {
    const c = COMBO_BY_ID.get(id);
    if (!c) return;
    const lvl = starLevel(this.progress, id);
    const cost = upgradeCost(id, lvl);
    const maxed = cost < 0;
    const afford = !maxed && this.progress.coins >= cost;
    const x = this.cardX(i, n);
    const y = 302;
    const bg = this.add
      .rectangle(x, y, 150, 170, afford ? 0x1e3a1e : 0x1a2230)
      .setStrokeStyle(2, maxed ? 0xffd76a : afford ? 0x9aff9a : 0x55607a, 1)
      .setInteractive({ useHandCursor: !maxed });
    ov.add(bg);
    const icon = this.add.text(x, y - 62, c.icon, { fontSize: '30px' }).setOrigin(0.5);
    ov.add(icon);
    const name = this.add
      .text(x, y - 36, c.name, { fontSize: '13px', color: '#ffffff', fontStyle: 'bold', align: 'center', wordWrap: { width: 140 } })
      .setOrigin(0.5, 0);
    ov.add(name);
    const arrows = this.add
      .text(x, y - 8, c.points.map((d) => SWIPE_ARROW[d]).join(' '), { fontSize: '13px', color: '#9ab3ff' })
      .setOrigin(0.5);
    ov.add(arrows);
    const cur = effectivePower(c.power, lvl);
    const next = maxed ? cur : effectivePower(c.power, lvl + 1);
    const powerLine = c.kind === 'damage' ? `⚔ ${cur} → ${next}` : c.kind === 'buff_next' ? `✨ ${cur}% → ${next}%` : `💚 ${cur} → ${next}`;
    const power = this.add.text(x, y + 12, maxed ? `${this.effectLabel({ ...c, power: cur })} MAX` : powerLine, {
      fontSize: '12px',
      color: '#cfe8cf',
    }).setOrigin(0.5);
    ov.add(power);
    const costTx = this.add
      .text(x, y + 32, maxed ? 'MAX ★★★' : `${cost}💰 улучшить`, {
        fontSize: '13px',
        color: maxed ? '#ffd76a' : afford ? '#ffd76a' : '#ff9a9a',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);
    thicken(costTx, 3);
    ov.add(costTx);
    // Маленькая жёлтая звёздочка(и) под способностью — уровень усиления.
    const stars = this.add
      .text(x, y + 52, starsText(lvl), { fontSize: '15px', color: '#ffd76a', fontStyle: 'bold' })
      .setOrigin(0.5);
    thicken(stars, 3);
    ov.add(stars);
    if (!maxed) {
      bg.on('pointerup', () => this.tryBuyUpgrade(id));
    }
  }

  private renderNewCard(ov: Phaser.GameObjects.Container, id: string, i: number, n: number): void {
    const c = COMBO_BY_ID.get(id);
    if (!c) return;
    const cost = buyCost(id);
    const afford = this.progress.coins >= cost;
    const x = this.cardX(i, n);
    const y = 508;
    const bg = this.add
      .rectangle(x, y, 150, 168, afford ? 0x1e2a4a : 0x1a2230)
      .setStrokeStyle(2, afford ? 0x9ab3ff : 0x55607a, 1)
      .setInteractive({ useHandCursor: true });
    ov.add(bg);
    const icon = this.add.text(x, y - 60, c.icon, { fontSize: '30px' }).setOrigin(0.5);
    ov.add(icon);
    const name = this.add
      .text(x, y - 34, c.name, { fontSize: '13px', color: '#ffffff', fontStyle: 'bold', align: 'center', wordWrap: { width: 140 } })
      .setOrigin(0.5, 0);
    ov.add(name);
    const arrows = this.add
      .text(x, y - 6, c.points.map((d) => SWIPE_ARROW[d]).join(' '), { fontSize: '13px', color: '#9ab3ff' })
      .setOrigin(0.5);
    ov.add(arrows);
    const power = this.add.text(x, y + 14, this.effectLabel(c), { fontSize: '12px', color: '#cfe8cf' }).setOrigin(0.5);
    ov.add(power);
    const costTx = this.add
      .text(x, y + 34, `${cost}💰 купить`, {
        fontSize: '13px',
        color: afford ? '#ffd76a' : '#ff9a9a',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);
    thicken(costTx, 3);
    ov.add(costTx);
    // Новая способность — пока 0 звёзд (☆☆☆).
    const stars = this.add.text(x, y + 54, starsText(0), { fontSize: '15px', color: '#ffd76a', fontStyle: 'bold' }).setOrigin(0.5);
    thicken(stars, 3);
    ov.add(stars);
    bg.on('pointerup', () => this.tryBuyNew(id));
  }

  private tryBuyUpgrade(id: string): void {
    if (!this.shopOpen) return;
    const c = COMBO_BY_ID.get(id);
    if (!c || !this.progress.owned.includes(id)) return;
    const lvl = starLevel(this.progress, id);
    const cost = upgradeCost(id, lvl);
    if (cost < 0) {
      sfx.wrong();
      return;
    }
    if (this.progress.coins < cost) {
      sfx.wrong();
      this.cameras.main.shake(60, 0.003);
      return;
    }
    this.progress.coins -= cost;
    this.progress.stars[id] = Math.min(SHOP_CONFIG.maxStars, lvl + 1);
    sfx.perfect();
    this.cameras.main.flash(100, 255, 215, 106);
    // Убрать макснутые и добить ряд оставшимися улучшаемыми.
    this.shopOffers = sanitizeOffers(ALL_COMBOS, this.progress, this.shopOffers);
    this.saveProgress();
    this.renderShop();
    this.refreshHud(`⬆ ${c.icon} ${c.name} улучшено до ${starsText(this.progress.stars[id])}! Сила ${effectivePower(c.power, lvl)} → ${effectivePower(c.power, lvl + 1)}. 💰 ${this.progress.coins}.`);
    applyThickFont(this);
  }

  private tryBuyNew(id: string): void {
    if (!this.shopOpen) return;
    const c = COMBO_BY_ID.get(id);
    if (!c || this.progress.owned.includes(id)) return;
    const cost = buyCost(id);
    if (this.progress.coins < cost) {
      sfx.wrong();
      this.cameras.main.shake(60, 0.003);
      return;
    }
    this.progress.coins -= cost;
    this.progress.owned.push(id);
    this.progress.stars[id] = 0;
    sfx.perfect();
    this.cameras.main.flash(120, 154, 179, 255);
    this.shopOffers = sanitizeOffers(ALL_COMBOS, this.progress, this.shopOffers);
    this.saveProgress();
    this.renderShop();
    this.refreshHud(`✨ Новая способность ${c.icon} ${c.name}! Теперь в бою: ${this.progress.owned.length}/${ALL_COMBOS.length}. 💰 ${this.progress.coins}.`);
    applyThickFont(this);
  }

  private rerollShop(): void {
    if (!this.shopOpen) return;
    const cost = SHOP_CONFIG.rerollCost;
    if (this.progress.coins < cost) {
      sfx.wrong();
      this.cameras.main.shake(60, 0.003);
      return;
    }
    this.progress.coins -= cost;
    this.shopOffers = rollShopOffers(ALL_COMBOS, this.progress);
    // Если ролл пустой (всё куплено/макснуто) — оставить санитизированный.
    const sanitized = sanitizeOffers(ALL_COMBOS, this.progress, this.shopOffers);
    this.shopOffers = sanitized;
    sfx.swipe();
    this.saveProgress();
    this.renderShop();
    this.refreshHud(`↻ Предложения обновлены за ${cost}💰. Осталось 💰 ${this.progress.coins}.`);
    applyThickFont(this);
  }
}
