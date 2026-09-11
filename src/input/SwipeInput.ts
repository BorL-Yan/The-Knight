import type { SwipeDir } from '../combat/types';

export const DEFAULT_SWIPE_THRESHOLD_PX = 24;

/** Чистая функция: delta -> направление. null если движение слишком мало. */
export function detectSwipeDirection(
  dx: number,
  dy: number,
  thresholdPx = DEFAULT_SWIPE_THRESHOLD_PX,
): SwipeDir | null {
  if (Math.hypot(dx, dy) < thresholdPx) return null;
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? 'Right' : 'Left';
  }
  return dy > 0 ? 'Down' : 'Up';
}

/** Чистая функция: две точки -> направление. */
export function parseSwipe(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  thresholdPx = DEFAULT_SWIPE_THRESHOLD_PX,
): SwipeDir | null {
  return detectSwipeDirection(endX - startX, endY - startY, thresholdPx);
}

export interface SwipeInputOptions {
  thresholdPx?: number;
  onSwipe?: (dir: SwipeDir) => void;
  onTap?: () => void;
}

interface ActivePointer {
  id: number;
  startX: number;
  startY: number;
}

/**
 * Phaser-обертка над pointer-событиями.
 * - Лочит первый палец, игнорирует остальные (защита от мультитача).
 * - Работает на всей сцене или на заданной Zone/Container.
 */
export class SwipeInput {
  private active: ActivePointer | null = null;
  private readonly thresholdPx: number;
  private readonly scene: Phaser.Scene;
  private readonly opts: SwipeInputOptions;
  private destroyed = false;

  constructor(
    scene: Phaser.Scene,
    opts: SwipeInputOptions = {},
    attachTo?: Phaser.GameObjects.Zone | Phaser.GameObjects.Container | Phaser.GameObjects.Rectangle,
  ) {
    this.scene = scene;
    this.opts = opts;
    this.thresholdPx = opts.thresholdPx ?? DEFAULT_SWIPE_THRESHOLD_PX;

    if (attachTo) {
      attachTo.setInteractive({ useHandCursor: false });
      attachTo.on('pointerdown', this.handleDown);
      attachTo.on('pointerup', this.handleUp);
    } else {
      scene.input.on('pointerdown', this.handleDown);
      scene.input.on('pointerup', this.handleUp);
    }
  }

  onSwipe(cb: (dir: SwipeDir) => void): void {
    this.opts.onSwipe = cb;
  }

  onTap(cb: () => void): void {
    this.opts.onTap = cb;
  }

  private readonly handleDown = (pointer: Phaser.Input.Pointer): void => {
    if (this.destroyed || this.active !== null) return;
    // pointer.downElement / position
    this.active = { id: pointer.id, startX: pointer.x, startY: pointer.y };
  };

  private readonly handleUp = (pointer: Phaser.Input.Pointer): void => {
    if (this.destroyed || this.active === null) return;
    if (pointer.id !== this.active.id) return;

    const { startX, startY } = this.active;
    this.active = null;

    const dir = parseSwipe(startX, startY, pointer.x, pointer.y, this.thresholdPx);
    if (dir) {
      this.opts.onSwipe?.(dir);
    } else {
      this.opts.onTap?.();
    }
  };

  destroy(): void {
    this.destroyed = true;
    this.active = null;
    this.scene.input.off('pointerdown', this.handleDown);
    this.scene.input.off('pointerup', this.handleUp);
  }
}
