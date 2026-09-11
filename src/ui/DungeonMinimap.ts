import Phaser from 'phaser';
import { visibleIds, type DungeonGraph } from '../map/dungeon';

/**
 * Миникарта подземелья в правом верхнем углу (как на референсе).
 * - Каждый квадрат = одно поле, перемычки = связи links.
 * - Fog of war: рисуем только visibleIds() (посещённые + соседи текущей).
 * - Текущее поле — белые уголки-скобки, остальные — красные уголки.
 * - Иконки типов: хук drawRoomIcon() — сейчас 'normal' без иконки,
 *   новые RoomType подхватятся без переделки refresh().
 */
export class DungeonMinimap {
  readonly container: Phaser.GameObjects.Container;
  private g: Phaser.GameObjects.Graphics;
  private tile = 20;
  private gap = 6;
  private pad = 6;
  private marginRight = 8;
  private topY = 104;

  constructor(private scene: Phaser.Scene) {
    this.container = scene.add.container(0, 0);
    this.container.setScrollFactor(0);
    this.container.setDepth(90);
    this.g = scene.add.graphics();
    this.container.add(this.g);
  }

  /** Заглушка под будущие типы комнат (boss/treasure/shop/...). */
  private drawRoomIcon(g: Phaser.GameObjects.Graphics, type: string, cx: number, cy: number): void {
    switch (type) {
      case 'normal':
      default:
        break;
      // Будущее:
      // case 'boss': иконка черепа красным
      // case 'treasure': квадрат-контур
      // case 'shop': '!'
    }
    void g;
    void cx;
    void cy;
  }

  refresh(graph: DungeonGraph): void {
    const vis = visibleIds(graph);
    const nodes = [...graph.nodes.values()].filter((n) => vis.has(n.id));
    this.g.clear();
    if (nodes.length === 0) {
      this.container.setVisible(false);
      return;
    }
    this.container.setVisible(true);

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
    const contentH = (maxGy - minGy + 1) * step - this.gap;
    const boxW = contentW + this.pad * 2;
    const boxH = contentH + this.pad * 2;

    // Держим правый край на месте при расширении fog.
    const { width } = this.scene.scale;
    this.container.setPosition(width - boxW - this.marginRight, this.topY);

    const at = (gx: number, gy: number): { x: number; y: number } => ({
      x: this.pad + (gx - minGx) * step,
      y: this.pad + (gy - minGy) * step,
    });

    const ROOM = 0xf5a83b;
    const CORNER = 0xc93a3a;
    const CURRENT = 0xffffff;
    const byId = new Map(nodes.map((n) => [n.id, n]));

    // Фон-подложка чтобы не сливаться с полем.
    this.g.fillStyle(0x14101f, 0.78);
    this.g.fillRect(0, 0, boxW, boxH);

    // Коридоры: только между двумя видимыми комнатами, поверх фона, под комнатами.
    this.g.fillStyle(ROOM, 1);
    for (const n of nodes) {
      const p = at(n.gx, n.gy);
      const cx = p.x + this.tile / 2;
      const cy = p.y + this.tile / 2;
      const e = n.links.E ? byId.get(n.links.E) : null;
      if (e) {
        const q = at(e.gx, e.gy);
        const nx = q.x + this.tile / 2;
        const x0 = Math.min(cx, nx);
        this.g.fillRect(x0, cy - 3, Math.abs(nx - cx), 6);
      }
      const s = n.links.S ? byId.get(n.links.S) : null;
      if (s) {
        const q = at(s.gx, s.gy);
        const ny = q.y + this.tile / 2;
        const y0 = Math.min(cy, ny);
        this.g.fillRect(cx - 3, y0, 6, Math.abs(ny - cy));
      }
    }

    // Комнаты.
    for (const n of nodes) {
      const p = at(n.gx, n.gy);
      const isCurrent = n.id === graph.currentId;
      this.g.fillStyle(ROOM, 1);
      this.g.fillRect(p.x, p.y, this.tile, this.tile);
      const cornerColor = isCurrent ? CURRENT : CORNER;
      const c = 4; // размер уголка
      const t = isCurrent ? 3 : 2; // толщина уголка
      this.g.fillStyle(cornerColor, 1);
      // 4 уголка: TL, TR, BL, BR
      this.g.fillRect(p.x, p.y, c, t);
      this.g.fillRect(p.x, p.y, t, c);
      this.g.fillRect(p.x + this.tile - c, p.y, c, t);
      this.g.fillRect(p.x + this.tile - t, p.y, t, c);
      this.g.fillRect(p.x, p.y + this.tile - t, c, t);
      this.g.fillRect(p.x, p.y + this.tile - c, t, c);
      this.g.fillRect(p.x + this.tile - c, p.y + this.tile - t, c, t);
      this.g.fillRect(p.x + this.tile - t, p.y + this.tile - c, t, c);
      this.drawRoomIcon(this.g, n.type, p.x + this.tile / 2, p.y + this.tile / 2);
      if (isCurrent) {
        // Точка игрока в центре текущей комнаты.
        this.g.fillStyle(0xffffff, 1);
        this.g.fillCircle(p.x + this.tile / 2, p.y + this.tile / 2, 2.4);
      }
    }
  }

  destroy(): void {
    this.container.destroy(true);
  }
}
