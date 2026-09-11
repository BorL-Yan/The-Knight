import Phaser from 'phaser';
import { CombatController } from '../combat/CombatController';
import type { ComboData } from '../combat/types';
import { SWIPE_ARROW } from '../combat/types';
import { SwipeInput } from '../input/SwipeInput';
import { applyThickFont, comboText, thicken } from '../ui/font';
import { sfx } from '../audio/sfx';
import combosJson from '../data/combos.json';
import type { EnemyData } from '../combat/CombatController';
import { ENEMY_CATALOG, normalizeEnemyId } from '../map/fieldConfig';

import {
  cloneProgress,
  effectiveCombos,
  loadProgress,
  starLevel,
  starsText,
  type PlayerProgressData,
} from '../combat/playerProgress';

const ALL_COMBOS = combosJson as ComboData[];
const ENEMIES: EnemyData[] = ENEMY_CATALOG.map((e) => ({ ...e }));
const LAB_WAVE_IDS = ['enemy_moth', 'enemy_slime', 'enemy_gator', 'elite_wraith', 'miniboss_boar', 'boss_hollow'];
const LAB_WAVES: EnemyData[] = LAB_WAVE_IDS.map((id) => ENEMIES.find((e) => e.id === id) ?? ENEMIES[0]);
function findEnemy(id: string): EnemyData {
  const norm = normalizeEnemyId(id);
  return ENEMIES.find((e) => e.id === norm) ?? ENEMIES[0];
}

const HERO_TEXTURE = 'herro';
const FIGHTER_SIZE = 130;

// --- Размеры шрифтов (меняйте здесь, чтобы увеличить/уменьшить текст) ---
const FONT_COINS = 26;
const FONT_HERO_NAME = 26;
const FONT_TURN = 25;
const FONT_WAVE = 19;
const FONT_HP = 23;
const FONT_BUFF = 21;
const FONT_COMBO_INPUT = 54;
const FONT_STATUS = 21;
const FONT_SWIPE_HINT = 28;
const FONT_RESET = 22;
const FONT_CROSS = 36;
const FONT_CROSS_LABEL = 16;
const FONT_MENU_TITLE = 25;
const FONT_MENU_BODY = 19;
const FONT_HINT_HEADER = 19;
const FONT_HINT_NAME = 17;
const FONT_HINT_ARROW = 20;

/**
 * CombatLabScene — пошаговый стенд с волнами и расширенными комбо:
 * - Игрок Herro СЛЕВА (портрет в левом углу), противник СПРАВА.
 * - Волны: moth -> slime -> gator -> wraith -> boar -> hollow, число ударов за ход растет.
 * - Все комбо собраны на ОДНОЙ панели, панель ВЫКЛЮЧЕНА по умолчанию
 *   и включается только по нажатию на кнопку ✚ (повторное нажатие — закрыть).
 * - Пока игрок набирает комбинацию, в ПРАВОМ углу показывается hint-панель:
 *   какие способности подходят под текущий префикс и что нажать дальше.
 * - buff_next тратит ход (враг отвечает), heal — нет.
 * - Кулдауны сложных комбо — в ходах игрока.
 */
export class CombatLabScene extends Phaser.Scene {
  private controller!: CombatController;
  private swipe!: SwipeInput;
  private comboById = new Map<string, ComboData>();
  /** Owned-комбо с учётом звёзд (источник — магазин торговца). */
  private ownedCombos: ComboData[] = [];
  /** Прогресс забега (монеты зачисляются сюда сразу при убийстве). */
  private progress: PlayerProgressData = loadProgress(null);
  /** Сколько монет контроллера уже зачислено в progress (чтобы не двоить). */
  private bankedCoins = 0;
  /** Дуэль с поля: один враг + возврат на ту же клетку после победы. */
  private duel: {
    uid: number;
    enemyId: string;
    playerHp: number;
    playerMaxHp: number;
    attackType?: string;
    fieldNum?: number;
  } | null = null;
  private duelEnemy: EnemyData | null = null;
  private returnedToMap = false;

  private enemyHpText!: Phaser.GameObjects.Text;
  private playerHpText!: Phaser.GameObjects.Text;
  private buffText!: Phaser.GameObjects.Text;
  private turnText!: Phaser.GameObjects.Text;
  private waveText!: Phaser.GameObjects.Text;
  private comboText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private cornerBox!: Phaser.GameObjects.Container;
  private hintBox!: Phaser.GameObjects.Container;
  private enemyImg!: Phaser.GameObjects.Image;
  private heroImg!: Phaser.GameObjects.Image;
  private heroBaseScale = 1;
  private enemyBaseScale = 1;

  private menuOpen = false;
  private menuOverlay: Phaser.GameObjects.Container | null = null;

  constructor() {
    super('CombatLab');
  }

  preload(): void {
    this.load.image(HERO_TEXTURE, 'assets/characters/Herro.png');
    for (const e of ENEMIES) {
      if (e.texture) {
        this.load.image(e.texture, `assets/characters/details/${e.texture}.png`);
      }
    }
    // Легаси-файлы корня (старые сейвы/кэш): подхватить если есть.
    this.load.image('enemy_1', 'assets/characters/Enemy_1.png');
    this.load.image('enemy_2', 'assets/characters/Enemy_2.png');
    this.load.image('enemy_boss', 'assets/characters/Enemy_Boss.png');
  }

  /** Масштабировать спрайт чтобы вписался в target px. Возвращает scale. */
  private fit(img: Phaser.GameObjects.Image, target: number): number {
    const t = this.textures.get(img.texture.key).getSourceImage() as { width: number; height: number };
    const w = t.width || 1;
    const h = t.height || 1;
    const s = target / Math.max(w, h);
    img.setScale(s);
    return s;
  }

  create(
    data?: {
      duel?: {
        uid: number;
        enemyId: string;
        playerHp: number;
        playerMaxHp?: number;
        damageOverride?: number;
        attackType?: string;
        fieldNum?: number;
      };
    },
  ): void {
    const { width, height } = this.scale;
    this.cameras.main.setBackgroundColor('#20242b');
    this.cameras.main.fadeIn(200, 0, 0, 0);
    this.returnedToMap = false;
    this.bankedCoins = 0;

    // Прогресс из магазина: монеты + owned + звёзды. Бой идёт только owned-комбо
    // с пересчитанным power (effectiveCombos).
    this.progress = loadProgress(this.registry.get('playerProgress'));
    this.ownedCombos = effectiveCombos(ALL_COMBOS, this.progress);
    this.comboById = new Map(this.ownedCombos.map((c) => [c.id, c]));
    this.registry.set('playerProgress', cloneProgress(this.progress));
    if (data?.duel) {
      const base = findEnemy(data.duel?.enemyId ?? 'enemy_moth');
      // Урон растёт с глубиной (damageGrowth из enemies.json уже применён сценой карты).
      const found: EnemyData =
        typeof data.duel.damageOverride === 'number'
          ? { ...base, damage: data.duel.damageOverride }
          : { ...base };
      if (data.duel.attackType) found.attackType = data.duel.attackType;
      this.duelEnemy = found;
      this.duel = {
        uid: data.duel.uid,
        enemyId: found.id,
        playerHp: data.duel.playerHp,
        playerMaxHp: data.duel.playerMaxHp ?? 150,
        attackType: found.attackType,
        fieldNum: data.duel.fieldNum,
      };
      this.controller = new CombatController(
        {
          enemies: [found],
          combos: this.ownedCombos,
          playerMaxHp: this.duel.playerMaxHp,
          playerHp: this.duel.playerHp,
        },
        () => this.time.now,
      );
    } else {
      this.duel = null;
      this.duelEnemy = null;
      this.controller = new CombatController(
        {
          enemies: LAB_WAVES,
          combos: this.ownedCombos,
          playerMaxHp: 150,
        },
        () => this.time.now,
      );
    }

    // --- Верхний HUD ---
    this.add.text(16, 10, '💰 0', { fontSize: `${FONT_COINS}px`, color: '#ffd76a' }).setName('coins');
    // Игрок Herro нарисован в ЛЕВОМ углу экрана.
    const portrait = this.add.image(28, 52, HERO_TEXTURE).setOrigin(0.5, 0.5);
    this.fit(portrait, 40);
    this.add
      .text(52, 52, 'Herro', { fontSize: `${FONT_HERO_NAME}px`, color: '#9aff9a', fontStyle: 'bold' })
      .setOrigin(0, 0.5);
    this.turnText = this.add
      .text(width / 2, 12, '', { fontSize: `${FONT_TURN}px`, color: '#9aff9a', fontStyle: 'bold' })
      .setOrigin(0.5, 0);
    this.waveText = this.add
      .text(width / 2, 42, '', { fontSize: `${FONT_WAVE}px`, color: '#cfe8cf' })
      .setOrigin(0.5, 0);

    // --- Угловая комбо-панель ВЫКЛЮЧЕНА: все комбо живут только на одной
    // --- панели-меню, которая скрыта и открывается по нажатию ✚.
    this.cornerBox = this.add.container(12, 78);
    this.cornerBox.setVisible(false);

    // --- Hint-панель в ПРАВОМ углу: какие способности доступны под текущий ввод.
    // --- Видна только пока игрок набирает комбинацию (префикс не пуст).
    const hintWidth = 220;
    this.hintBox = this.add.container(width - hintWidth - 12, 78).setDepth(50);
    this.hintBox.setVisible(false);

    // --- Бойцы ГОРИЗОНТАЛЬНО: Herro СЛЕВА, противник СПРАВА ---
    const fightY = height * 0.38;
    const heroX = width * 0.26;
    const enemyX = width * 0.74;

    this.add.ellipse(heroX, fightY + 78, 120, 26, 0x000000, 0.35);
    this.add.ellipse(enemyX, fightY + 78, 120, 26, 0x000000, 0.35);

    this.playerHpText = this.add
      .text(heroX, fightY - 110, '', { fontSize: `${FONT_HP}px`, color: '#9aff9a' })
      .setOrigin(0.5);
    this.buffText = this.add
      .text(heroX, fightY - 142, '', { fontSize: `${FONT_BUFF}px`, color: '#ffd76a', fontStyle: 'bold' })
      .setOrigin(0.5);
    this.enemyHpText = this.add
      .text(enemyX, fightY - 110, '', { fontSize: `${FONT_HP}px`, color: '#ff9a9a' })
      .setOrigin(0.5);

    this.heroImg = this.add.image(heroX, fightY, HERO_TEXTURE);
    this.heroBaseScale = this.fit(this.heroImg, FIGHTER_SIZE);

    const firstEnemy = this.controller.getEnemy();
    this.enemyImg = this.add.image(enemyX, fightY, firstEnemy.texture ?? 'enemy_moth');
    this.enemyBaseScale = this.fit(this.enemyImg, FIGHTER_SIZE);
    this.enemyImg.setFlipX(true);

    this.add
      .text(width / 2, fightY, '⚔️', { fontSize: '36px' })
      .setOrigin(0.5)
      .setAlpha(0.8);

    // --- Текущий ввод ---
    this.comboText = this.add
      .text(width / 2, height * 0.54, '', { fontSize: `${FONT_COMBO_INPUT}px`, color: '#ffffff' })
      .setOrigin(0.5);
    const duelIntro = (): string => {
      if (!this.duel) return 'Твой ход — собери комбо (нажми ✚ чтобы посмотреть комбо)';
      const e = this.controller.getEnemy();
      const atk = e.attackType ? ` [${e.attackType} ${e.damage}]` : '';
      const f = this.duel.fieldNum ? ` • поле #${this.duel.fieldNum}` : '';
      return `⚔️ Дуэль с ${e.name}${atk}! Победи — вернёшься на то же поле${f}`;
    };
    this.statusText = this.add
      .text(width / 2, height * 0.6, duelIntro(), {
        fontSize: `${FONT_STATUS}px`,
        color: '#cfe8cf',
        align: 'center',
        wordWrap: { width: width - 60 },
      })
      .setOrigin(0.5);

    // --- Swipe-зона ---
    const zone = this.add.rectangle(width / 2, height * 0.81, width - 32, height * 0.24, 0x2b3340);
    zone.setStrokeStyle(3, 0x7c8aa5);
    this.add
      .text(width / 2, height * 0.81, 'SWIPE HERE', { fontSize: `${FONT_SWIPE_HINT}px`, color: '#7c8aa5' })
      .setOrigin(0.5);

    this.swipe = new SwipeInput(this, { thresholdPx: 24 }, zone);
    this.swipe.onSwipe((dir) => this.onSwipe(dir));

    const resetBtn = this.add
      .rectangle(width / 2, height * 0.67, 220, 50, 0x444c5e)
      .setInteractive({ useHandCursor: true });
    this.add
      .text(width / 2, height * 0.67, '↻ RESET', { fontSize: `${FONT_RESET}px`, color: '#fff' })
      .setOrigin(0.5);
    resetBtn.on('pointerup', () => this.resetFight());
    this.input.keyboard?.on('keydown-R', () => this.resetFight());

    // --- Кнопка ✚: единственная комбо-панель, вкл/выкл только по нажатию ---
    const crossX = width - 52;
    const crossY = height * 0.6;
    const cross = this.add.circle(crossX, crossY, 34, 0x444c5e);
    cross.setStrokeStyle(3, 0xffffff);
    cross.setInteractive({ useHandCursor: true });
    this.add.text(crossX, crossY, '✚', { fontSize: `${FONT_CROSS}px`, color: '#fff' }).setOrigin(0.5);
    this.add
      .text(crossX, crossY + 42, 'комбо', { fontSize: `${FONT_CROSS_LABEL}px`, color: '#7c8aa5' })
      .setOrigin(0.5);
    cross.on('pointerup', () => {
      this.toggleMenu();
    });

    applyThickFont(this);
    this.refreshHud();
  }

  // ---------- Единственная комбо-панель (скрыта, вкл только по нажатию ✚) ----------

  private toggleMenu(): void {
    if (this.menuOpen) this.closeMenu();
    else this.openMenu();
  }

  private effectLabel(c: ComboData): string {
    if (c.kind === 'damage') return `${c.power}`;
    if (c.kind === 'buff_next') return `+${c.power}% след.`;
    return `+${c.power}HP`;
  }

  private openMenu(): void {
    if (this.menuOpen) return;
    this.menuOpen = true;
    const { width, height } = this.scale;
    // Одна общая панель для ВСЕХ owned-комбинаций (с учётом магазина).
    // Включается только по нажатию ✚.
    const ov = this.add.container(0, 0).setDepth(100);
    const dim = this.add.rectangle(0, 0, width, height, 0x000000, 0.72).setOrigin(0, 0);
    dim.setInteractive();
    dim.on('pointerup', () => this.closeMenu());
    ov.add(dim);

    const lines = this.ownedCombos.map((c) => {
      const arrows = c.points.map((d) => SWIPE_ARROW[d]).join(' ');
      const cd = c.cooldownTurns > 0 ? `КД${c.cooldownTurns}х` : '—';
      const turn = c.consumesTurn ? '' : '·без ответа';
      const limit = c.timeLimitMs > 0 ? `·${Math.round(c.timeLimitMs / 1000)}с` : '';
      const lvl = starLevel(this.progress, c.id);
      const stars = starsText(lvl);
      return `${c.icon} ${c.name} ${arrows} · ${this.effectLabel(c)} · ${cd}${turn}${limit} · ${stars}`;
    });
    const title = this.add
      .text(width / 2, height * 0.22, '✚ КОМБО — нажми ✚ чтобы закрыть', {
        fontSize: `${FONT_MENU_TITLE}px`,
        color: '#ffd76a',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);
    thicken(title, 5);
    ov.add(title);

    const body = comboText(this, width / 2 - (width - 110) / 2, height * 0.28, lines.join('\n'), FONT_MENU_BODY, '#e8f0e8', 4);
    body.setLineSpacing(13);
    ov.add(body);

    const panelH = lines.length * 38 + 130;
    const panel = this.add.rectangle(width / 2, height * 0.28 + panelH / 2 - 20, width - 60, panelH, 0x141a24, 0.0);
    panel.setStrokeStyle(2, 0xffd76a, 0.9);
    ov.add(panel);
    ov.sendToBack(panel);
    ov.sendToBack(dim);

    this.menuOverlay = ov;
    ov.setVisible(true);
    this.statusText.setText('Меню комбо — нажми ✚ чтобы закрыть').setColor('#ffd76a');
  }

  private closeMenu(): void {
    this.menuOpen = false;
    this.menuOverlay?.destroy(true);
    this.menuOverlay = null;
    this.statusText.setText('Твой ход — собери следующее комбо').setColor('#cfe8cf');
    this.refreshHud();
  }

  // ---------- Бой ----------

  /** Зачислить новые монеты контроллера в прогресс (чтобы карта их видела). */
  private bankCoins(): void {
    const cur = this.controller.getCoins();
    const diff = cur - this.bankedCoins;
    if (diff > 0) {
      this.progress.coins += diff;
      this.bankedCoins = cur;
      this.registry.set('playerProgress', cloneProgress(this.progress));
    } else if (diff < 0) {
      // Контроллер пересоздан (reset) — синхронизируем базу.
      this.bankedCoins = cur;
    }
  }

  private resetFight(): void {
    if (this.menuOpen) this.closeMenu();
    if (this.duel && this.duelEnemy) {
      // Дуэль: пересоздаём бой с тем же врагом и стартовым HP входа.
      this.controller = new CombatController(
        {
          enemies: [this.duelEnemy],
          combos: this.ownedCombos,
          playerMaxHp: this.duel.playerMaxHp,
          playerHp: this.duel.playerHp,
        },
        () => this.time.now,
      );
      this.bankedCoins = 0;
      this.returnedToMap = false;
      this.enemyImg.setTexture(this.controller.getEnemy().texture ?? 'enemy_moth');
      this.enemyBaseScale = this.fit(this.enemyImg, FIGHTER_SIZE);
      const re = this.controller.getEnemy();
      this.statusText
        .setText(
          `⚔️ Дуэль с ${re.name}${re.attackType ? ` [${re.attackType} ${re.damage}]` : ''}! Победи — вернёшься на то же поле`,
        )
        .setColor('#cfe8cf');
      this.refreshHud();
      return;
    }
    this.controller.resetFight();
    this.enemyImg.setTexture(this.controller.getEnemy().texture ?? 'enemy_moth');
    this.enemyBaseScale = this.fit(this.enemyImg, FIGHTER_SIZE);
    this.statusText.setText('Твой ход — собери комбо (нажми ✚ чтобы посмотреть комбо)').setColor('#cfe8cf');
    this.refreshHud();
  }

  /** Возврат на то же поле после дуэли: победа — та же клетка, поражение — спавн. */
  private returnToMap(victory: boolean): void {
    if (!this.duel || this.returnedToMap) return;
    this.returnedToMap = true;
    this.bankCoins();
    this.registry.set('duelResult', {
      uid: this.duel.uid,
      victory,
      playerHpLeft: this.controller.getPlayerHp(),
      coinsEarned: this.bankedCoins,
    });
    this.cameras.main.flash(victory ? 150 : 220, 255, 255, 255);
    this.scene.start('MapTest', { fromCombat: true });
  }

  private onSwipe(dir: Parameters<Parameters<SwipeInput['onSwipe']>[0]>[0]): void {
    if (this.menuOpen) {
      this.statusText.setText('Нажми ✚ чтобы закрыть меню').setColor('#ffcf6a');
      return;
    }
    if (this.controller.isGameOver()) {
      this.refreshHud();
      return;
    }
    if (!this.controller.isPlayerTurn()) {
      const left = this.controller.getStrikesLeft();
      this.statusText
        .setText(left > 0 ? `⏳ Противник бьет... (еще ${left})` : '⏳ Жди ответного удара...')
        .setColor('#ffcf6a');
      return;
    }
    sfx.swipe();
    const res = this.controller.handleSwipe(dir);

    if (res.ignoredNotPlayerTurn) {
      this.statusText.setText('⏳ Сейчас не твой ход').setColor('#ffcf6a');
      return;
    }

    const outcome = res.outcome;
    if (outcome.result === 'next') {
      sfx.correct();
      this.flashCombo('#9ab3ff');
      this.statusText.setText('Верно... смотри правый угол 👀').setColor('#9aff9a');
    } else if (outcome.result === 'reset') {
      sfx.wrong();
      this.cameras.main.shake(80, 0.004);
      this.flashCombo('#ff5a5a');
      this.statusText
        .setText(`${SWIPE_ARROW[dir]} мимо — комбо сброшено (жесткий ресет)`)
        .setColor('#ff9a9a');
    } else if (outcome.result === 'expired') {
      sfx.wrong();
      this.cameras.main.shake(80, 0.004);
      this.flashCombo('#ff5a5a');
      this.statusText
        .setText(`⏳ Время вышло — ${outcome.combo.icon} ${outcome.combo.name} сгорело`)
        .setColor('#ff9a9a');
    } else if (outcome.combo.kind === 'heal') {
      // Лечение ход НЕ тратит: враг не отвечает.
      sfx.correct();
      this.tweens.add({ targets: this.heroImg, scale: { from: this.heroBaseScale * 1.12, to: this.heroBaseScale }, duration: 180 });
      this.floatText(this.heroImg.x, `+${res.healed}`, '#7dff9a');
      this.statusText
        .setText(`${outcome.combo.icon} Heal +${res.healed}HP — враг не отвечает, твой ход!`)
        .setColor('#7dff9a');
    } else if (outcome.combo.kind === 'buff_next') {
      // Усиление ход тратит: враг отвечает.
      sfx.perfect();
      this.tweens.add({ targets: this.heroImg, scale: { from: this.heroBaseScale * 1.12, to: this.heroBaseScale }, duration: 180 });
      const mult = 1 + outcome.combo.power / 100;
      this.floatText(this.heroImg.x, `✨ ×${mult}`, '#ffd76a');
      const total = this.controller.getStrikesTotal();
      this.statusText
        .setText(`✨ Focus! Следующий удар ×${mult} — противник отвечает ×${total}...`)
        .setColor('#ffd76a');
      this.turnText.setText('🛡️ Ход противника').setColor('#ffcf6a');
      this.time.delayedCall(this.controller.getCounterDelayMs(), () => this.doEnemyStrike());
    } else {
      // damage — игрок завершил атаку
      const multLabel =
        outcome.multiplier === 1.4
          ? 'PERFECT ×1.4'
          : outcome.multiplier === 1.2
            ? 'FAST ×1.2'
            : '×1.0';
      if (outcome.multiplier >= 1.4) sfx.perfect();
      else sfx.hit();
      this.cameras.main.shake(90, 0.006);
      this.tweens.add({ targets: this.enemyImg, scale: { from: this.enemyBaseScale * 1.15, to: this.enemyBaseScale }, duration: 160 });
      const buffNote = res.buffUsed > 0 ? `✨×${res.buffUsed} ` : '';
      this.floatText(this.enemyImg.x, `${multLabel}\n${buffNote}-${res.dealt}`, '#ffd76a');

      if (res.enemyDead) {
        if (this.controller.hasNextWave()) {
          this.statusText
            .setText(
              `☠ ${this.controller.getEnemy().name} повержен! +${this.controller.coinReward}💰 ${outcome.combo.icon} ${outcome.combo.name} собрано — идет следующий...`,
            )
            .setColor('#ffd76a');
          this.time.delayedCall(1100, () => this.advanceWave());
        } else if (this.duel) {
          this.statusText
            .setText(`🏆 ${this.controller.getEnemy().name} повержен! +${this.controller.coinReward}💰 Возврат на то же поле...`)
            .setColor('#ffd76a');
          this.time.delayedCall(1400, () => this.returnToMap(true));
        } else {
          this.statusText
            .setText(`🏆 Все волны зачищены! +${this.controller.coinReward} coins — R/↻ заново`)
            .setColor('#ffd76a');
        }
      } else {
        const total = this.controller.getStrikesTotal();
        this.statusText
          .setText(
            `${buffNote}${outcome.combo.icon} ${outcome.combo.name}! ${multLabel} — противник отвечает ×${total}...`,
          )
          .setColor('#ffd76a');
        this.turnText.setText('🛡️ Ход противника').setColor('#ffcf6a');
        this.time.delayedCall(this.controller.getCounterDelayMs(), () => this.doEnemyStrike());
      }
    }

    this.refreshHud();
  }

  /** Один удар врага; если ударов осталось — планируем следующий. */
  private doEnemyStrike(): void {
    if (this.controller.isGameOver() || this.controller.isPlayerDead()) {
      if (this.duel && this.controller.isPlayerDead() && !this.returnedToMap) {
        this.statusText.setText('💀 Ты погиб в дуэли — возврат на спавн...').setColor('#ff9a9a');
        this.time.delayedCall(1600, () => this.returnToMap(false));
      }
      this.refreshHud();
      return;
    }
    const tick = this.controller.enemyStrike();
    if (tick.enemyHit) {
      sfx.hit();
      this.cameras.main.shake(70, 0.003);
      this.tweens.add({ targets: this.heroImg, scale: { from: this.heroBaseScale * 1.12, to: this.heroBaseScale }, duration: 160 });
      this.floatText(this.heroImg.x, `-${tick.damage}`, '#ff9a9a');
      if (tick.playerDead) {
        if (this.duel) {
          this.statusText.setText('💀 Ты погиб в дуэли — возврат на спавн...').setColor('#ff9a9a');
          this.time.delayedCall(1600, () => this.returnToMap(false));
        } else {
          this.statusText.setText('💀 Ты погиб — R/↻ для рестарта').setColor('#ff9a9a');
        }
      } else if (tick.strikesLeft > 0) {
        this.statusText
          .setText(`Противник бьет... (еще ${tick.strikesLeft})`)
          .setColor('#ffcf6a');
        this.time.delayedCall(450, () => this.doEnemyStrike());
      } else {
        this.statusText.setText('Твой ход — собери следующее комбо').setColor('#cfe8cf');
      }
    }
    this.refreshHud();
  }

  private advanceWave(): void {
    if (!this.controller.nextWave()) {
      this.refreshHud();
      return;
    }
    const enemy = this.controller.getEnemy();
    this.enemyImg.setTexture(enemy.texture ?? 'enemy_moth');
    this.enemyBaseScale = this.fit(this.enemyImg, FIGHTER_SIZE);
    this.cameras.main.flash(120, 255, 255, 255);
    this.statusText
      .setText(`${this.controller.getWaveText()}: ${enemy.name} (ударов ×${enemy.strikesPerTurn ?? 1}) — твой ход!`)
      .setColor('#cfe8cf');
    this.refreshHud();
  }

  // ---------- Угловая панель ВЫКЛЮЧЕНА: все комбо только на одной панели-меню ----------

  private renderCorner(): void {
    // Панель в углу больше не используется — держим контейнер пустым и скрытым,
    // чтобы осталась только одна панель со всеми комбинациями (по кнопке ✚).
    this.cornerBox.removeAll(true);
    this.cornerBox.setVisible(false);
  }

  // ---------- Hint-панель в ПРАВОМ углу: доступные способности под текущий ввод ----------
  private renderHint(): void {
    this.hintBox.removeAll(true);
    // Полное меню открыто — подсказку прячем, чтобы не перекрывать.
    if (this.menuOpen) {
      this.hintBox.setVisible(false);
      return;
    }
    const disc = this.controller.getDiscovery();
    const prefix = disc.getPrefix();
    const cont = disc.getContinuations();
    // Пока игрок ничего не набирает — панель скрыта.
    if (prefix.length === 0 || cont.length === 0) {
      this.hintBox.setVisible(false);
      return;
    }
    this.hintBox.setVisible(true);

    const W = 220;
    let y = 8;
    const items: Phaser.GameObjects.GameObject[] = [];

    const header = this.add.text(8, y, `🎯 Подходит: ${cont.length}`, {
      fontSize: `${FONT_HINT_HEADER}px`,
      color: '#ffd76a',
      fontStyle: 'bold',
    });
    thicken(header, 4);
    items.push(header);
    y += 30;

    const prefixStr = prefix.map((d) => SWIPE_ARROW[d]).join(' ');
    const prefixRow = comboText(this, 8, y, `Ввод: ${prefixStr}`, FONT_HINT_NAME, '#6fbf73', 3);
    items.push(prefixRow);
    y += 28;

    for (const m of cont) {
      const cd = this.controller.getCooldownLeft(m.comboId);
      const lvl = starLevel(this.progress, m.comboId);
      const stars = lvl > 0 ? ` ${starsText(lvl)}` : '';
      const nameRow = comboText(
        this,
        8,
        y,
        `${m.icon} ${m.name}${stars}${cd > 0 ? ` ·КД${cd}` : ''}`,
        FONT_HINT_NAME,
        '#e8f0e8',
        3,
      );
      items.push(nameRow);
      y += 24;

      let x = 22;
      const [next, ...rest] = m.remaining;
      if (next) {
        // Следующий нужный свайп — крупно и жёлтым.
        const hl = comboText(this, x, y, SWIPE_ARROW[next], FONT_HINT_ARROW + 4, '#ffd76a', 6);
        items.push(hl);
        x += hl.width + 10;
      }
      if (rest.length > 0) {
        const tail = comboText(
          this,
          x,
          y + 2,
          rest.map((d) => SWIPE_ARROW[d]).join(' '),
          FONT_HINT_ARROW - 2,
          '#ffffff',
          3,
        );
        items.push(tail);
      }
      y += 30;
    }

    const H = y + 8;
    const bg = this.add.rectangle(W / 2, H / 2, W, H, 0x141a24, 0.85);
    bg.setStrokeStyle(2, 0xffd76a, 0.7);
    this.hintBox.add(bg);
    for (const o of items) this.hintBox.add(o);
  }

  private refreshHud(): void {
    // Монеты за убийства сразу уходят в прогресс чтобы их видел торговец.
    this.bankCoins();
    const enemy = this.controller.getEnemy();
    const eHp = this.controller.getEnemyHp();
    const eMax = this.controller.getEnemyMaxHp();
    const pHp = this.controller.getPlayerHp();
    const pMax = this.controller.getPlayerMaxHp();
    this.enemyHpText.setText(`${enemy.name} ${eHp}/${eMax}`);
    this.playerHpText.setText(`❤️ ${pHp}/${pMax}`);
    const buff = this.controller.getBuffMult();
    this.buffText.setText(buff ? `✨ ×${buff}` : '');
    this.waveText.setText(
      this.duel
        ? `⚔️ Дуэль • ${enemy.name}${enemy.attackType ? ` [${enemy.attackType}]` : ''} • удары ×${enemy.strikesPerTurn ?? 1} • ✨${this.ownedCombos.length}`
        : `${this.controller.getWaveText()} • ${enemy.name} • удары ×${enemy.strikesPerTurn ?? 1} • ✨${this.ownedCombos.length}`,
    );

    if (this.controller.isVictory()) {
      this.turnText.setText('🏆 ПОБЕДА').setColor('#ffd76a');
    } else if (this.controller.isPlayerDead()) {
      this.turnText.setText('💀 ПОРАЖЕНИЕ').setColor('#ff9a9a');
    } else if (this.controller.isEnemyDead() && this.controller.hasNextWave()) {
      this.turnText.setText('✨ Волна зачищена!').setColor('#ffd76a');
    } else if (this.controller.getTurn() === 'player') {
      this.turnText.setText('🟢 Твой ход').setColor('#9aff9a');
    } else {
      const left = this.controller.getStrikesLeft();
      this.turnText.setText(left > 1 ? `🛡️ Враг бьет ×${left}` : '🛡️ Ход противника').setColor('#ffcf6a');
    }

    const prefix = this.controller.getDiscovery().getPrefix();
    this.comboText.setText(
      this.controller.isVictory() ? '🏆' : prefix.map((d) => SWIPE_ARROW[d]).join(' '),
    );

    this.renderCorner();
    this.renderHint();

    const coins = this.children.getByName('coins') as Phaser.GameObjects.Text | null;
    coins?.setText(`💰 ${this.progress.coins}`);
  }

  private flashCombo(color: string): void {
    this.comboText.setColor(color);
    this.time.delayedCall(120, () => this.comboText.setColor('#ffffff'));
    this.refreshHud();
  }

  private floatText(x: number, msg: string, color: string): void {
    const t = this.add
      .text(x, 220, msg, { fontSize: '40px', color, align: 'center', fontStyle: 'bold' })
      .setOrigin(0.5);
    thicken(t, 5);
    this.tweens.add({
      targets: t,
      y: 160,
      alpha: 0,
      duration: 850,
      ease: 'Cubic.easeOut',
      onComplete: () => t.destroy(),
    });
  }
}
