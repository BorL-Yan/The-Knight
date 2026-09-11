import Phaser from 'phaser';
import { applyThickFont, thicken } from '../ui/font';
import {
  generateDungeon,
  linkedDirs,
  neighborsOf,
  validateDungeon,
  type DungeonDir,
  type DungeonGraph,
} from '../map/dungeon';

const ROOM = 0xf5a83b;
const CORNER = 0xc93a3a;
const START_CORNER = 0xffffff;
const SELECT = 0x6fd3ff;

/**
 * Отдельная сцена просмотра генератора карты:
 * - видно весь граф целиком (без fog of war): комнаты, коридоры, старт;
 * - сид, статистика (комнаты/петли/тупики/валидность);
 * - R / кнопка — сгенерировать заново (seed+1);
 * - тап по комнате — детали (двери, сид поля);
 * - «Играть» — старт забега в MapTest с этим сидом.
 */
export class DungeonPreviewScene extends Phaser.Scene {
  private seed = 12345;
  private graph: DungeonGraph | null = null;
  private selectedId: string | null = null;
  private graphLayer: Phaser.GameObjects.Container | null = null;
  private seedText!: Phaser.GameObjects.Text;
  private statsText!: Phaser.GameObjects.Text;
  private infoText!: Phaser.GameObjects.Text;

  private readonly tile = 36;
  private readonly gap = 12;
  private readonly topY = 150;

  constructor() {
    super('DungeonPreview');
  }

  create(data?: { seed?: number }): void {
    const { width } = this.scale;
    this.cameras.main.setBackgroundColor('#14101f');
    this.cameras.main.fadeIn(200, 0, 0, 0);
    if (typeof data?.seed === 'number' && Number.isFinite(data.seed)) {
      this.seed = data.seed >>> 0;
    }
    this.selectedId = null;

    const title = this.add
      .text(width / 2, 10, '🗺 Генератор карты', {
        fontSize: '24px',
        color: '#ffd76a',
        fontStyle: 'bold',
      })
      .setOrigin(0.5, 0);
    thicken(title, 4);

    this.seedText = this.add
      .text(width / 2, 46, '', { fontSize: '17px', color: '#9aff9a', fontStyle: 'bold' })
      .setOrigin(0.5, 0);
    this.statsText = this.add
      .text(width / 2, 72, '', { fontSize: '15px', color: '#cfe8cf', align: 'center' })
      .setOrigin(0.5, 0);
    this.infoText = this.add
      .text(
        width / 2,
        100,
        '',
        { fontSize: '15px', color: '#6fd3ff', align: 'center', wordWrap: { width: width - 40 } },
      )
      .setOrigin(0.5, 0);

    this.regenerate(false);

    const { height } = this.scale;
    const y = height - 24;
    this.smallButton(100, y, 170, '↻ Новый (R)', () => this.regenerate(true));
    this.smallButton(300, y, 150, '▶ Играть', () =>
      this.scene.start('MapTest', { seed: this.seed }),
    );
    this.smallButton(455, y, 110, 'Меню', () => this.scene.start('Menu'));

    this.input.keyboard?.on('keydown-R', () => this.regenerate(true));
    this.input.keyboard?.on('keydown-M', () => this.scene.start('Menu'));
    applyThickFont(this);
  }

  /** Новый данж: seed+1 (или тот же при первом показе). */
  private regenerate(bump: boolean): void {
    if (bump) this.seed = (this.seed + 1) >>> 0;
    try {
      this.graph = generateDungeon({ seed: this.seed });
    } catch {
      this.graph = null;
    }
    this.selectedId = null;
    this.render();
  }

  private stats(): { rooms: number; loops: number; deadEnds: number; valid: boolean } {
    if (!this.graph) return { rooms: 0, loops: 0, deadEnds: 0, valid: false };
    const rooms = this.graph.nodes.size;
    let edges = 0;
    let deadEnds = 0;
    for (const n of this.graph.nodes.values()) {
      const deg = linkedDirs(n).length;
      edges += deg;
      if (deg === 1) deadEnds++;
    }
    return { rooms, loops: edges / 2 - (rooms - 1), deadEnds, valid: validateDungeon(this.graph).ok };
  }

  private render(): void {
    const { width } = this.scale;
    this.graphLayer?.destroy(true);
    this.graphLayer = this.add.container(0, 0);
    const g = this.add.graphics();
    this.graphLayer.add(g);

    if (!this.graph) {
      this.seedText.setText(`seed ${this.seed}`);
      this.statsText.setText('Генератор упал — жми R');
      this.infoText.setText('');
      return;
    }

    const nodes = [...this.graph.nodes.values()];
    let minGx = Infinity;
    let maxGx = -Infinity;
    let minGy = Infinity;
    let maxGy = -Infinity;
    for (const n of nodes) {
      minGx = Math.min(minGx, n.gx);
      maxGx = Math.max(maxGx, n.gx);
      minGy = Math.min(minGy, n.gy);
      maxGy = Math.max(maxGy, n.gy);
    }
    const step = this.tile + this.gap;
    const contentW = (maxGx - minGx + 1) * step - this.gap;
    const originX = Math.round((width - contentW) / 2);
    const at = (gx: number, gy: number): { x: number; y: number } => ({
      x: originX + (gx - minGx) * step,
      y: this.topY + (gy - minGy) * step,
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));

    // Коридоры — только между связанными (E/S чтобы не дублировать).
    g.fillStyle(ROOM, 1);
    for (const n of nodes) {
      const p = at(n.gx, n.gy);
      const cx = p.x + this.tile / 2;
      const cy = p.y + this.tile / 2;
      for (const d of ['E', 'S'] as DungeonDir[]) {
        const t = n.links[d];
        if (!t || !byId.has(t)) continue;
        const q = at(byId.get(t)!.gx, byId.get(t)!.gy);
        const nx = q.x + this.tile / 2;
        const ny = q.y + this.tile / 2;
        if (d === 'E') g.fillRect(Math.min(cx, nx), cy - 4, Math.abs(nx - cx), 8);
        else g.fillRect(cx - 4, Math.min(cy, ny), 8, Math.abs(ny - cy));
      }
    }

    // Комнаты + подписи id.
    for (const n of nodes) {
      const p = at(n.gx, n.gy);
      const isStart = n.id === this.graph.currentId;
      const isSel = n.id === this.selectedId;
      g.fillStyle(ROOM, 1);
      g.fillRect(p.x, p.y, this.tile, this.tile);
      const cc = isStart ? START_CORNER : CORNER;
      const c = 6;
      const t = 3;
      g.fillStyle(cc, 1);
      g.fillRect(p.x, p.y, c, t);
      g.fillRect(p.x, p.y, t, c);
      g.fillRect(p.x + this.tile - c, p.y, c, t);
      g.fillRect(p.x + this.tile - t, p.y, t, c);
      g.fillRect(p.x, p.y + this.tile - t, c, t);
      g.fillRect(p.x, p.y + this.tile - c, t, c);
      g.fillRect(p.x + this.tile - c, p.y + this.tile - t, c, t);
      g.fillRect(p.x + this.tile - t, p.y + this.tile - c, t, c);
      if (isStart) {
        g.fillStyle(0xffffff, 1);
        g.fillCircle(p.x + this.tile / 2, p.y + this.tile / 2 - 6, 3);
      }
      if (isSel) {
        g.lineStyle(3, SELECT, 1);
        g.strokeRect(p.x - 3, p.y - 3, this.tile + 6, this.tile + 6);
      }
      const label = this.add
        .text(p.x + this.tile / 2, p.y + this.tile / 2 + (isStart ? 8 : 0), n.id, {
          fontSize: '12px',
          color: '#3a2200',
          fontStyle: 'bold',
        })
        .setOrigin(0.5);
      this.graphLayer.add(label);

      const zone = this.add.zone(p.x, p.y, this.tile, this.tile).setOrigin(0, 0);
      zone.setInteractive({ useHandCursor: true });
      zone.on('pointerup', () => {
        this.selectedId = n.id;
        this.render();
      });
      this.graphLayer.add(zone);
    }

    const s = this.stats();
    this.seedText.setText(`seed ${this.seed} • старт: ${this.graph.currentId}`);
    this.statsText.setText(
      `комнат: ${s.rooms} • петли: ${s.loops} • тупики: ${s.deadEnds} • ${s.valid ? 'валиден ✓' : 'БИТЫЙ ✗'}`,
    );
    if (this.selectedId && byId.has(this.selectedId)) {
      const n = byId.get(this.selectedId)!;
      const doors = linkedDirs(n);
      const neigh = neighborsOf(this.graph, n.id)
        .map((m) => m.id)
        .join(' ');
      this.infoText.setText(
        `${n.id} (${n.gx},${n.gy}) • двери: ${doors.length > 0 ? doors.join(' ') : '—'}\n` +
          `→ ${neigh} • сид поля: ${n.seed}`,
      );
    } else {
      this.infoText.setText('Тап по комнате — двери и сид поля');
    }
    applyThickFont(this);
  }

  private smallButton(x: number, y: number, w: number, label: string, cb: () => void): void {
    const bg = this.add.rectangle(x, y, w, 40, 0x444c5e).setStrokeStyle(2, 0xffffff, 0.6);
    bg.setInteractive({ useHandCursor: true });
    const t = this.add.text(x, y, label, { fontSize: '16px', color: '#ffffff' }).setOrigin(0.5);
    thicken(t, 3);
    bg.on('pointerup', cb);
  }
}
