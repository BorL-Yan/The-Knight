import Phaser from 'phaser';

export const FONT_FAMILY = "'Rubik','Segoe UI',system-ui,sans-serif";

/** Отдельный шрифт для текста комбинаций (стрелки + подсветка). */
export const COMBO_FONT_FAMILY = "'JetBrains Mono','Rubik',monospace";

/** Делает текст толще: жирный + темная обводка. Стиль сохраняется при setText/setColor. */
export function thicken(
  t: Phaser.GameObjects.Text,
  strokeThickness?: number,
): Phaser.GameObjects.Text {
  t.setFontFamily(FONT_FAMILY);
  t.setFontStyle('bold');
  const size = parseInt(String(t.style.fontSize ?? '16'), 10) || 16;
  t.setStroke('rgba(0,0,0,0.6)', strokeThickness ?? Math.max(2, Math.round(size / 7)));
  t.setShadow(0, 2, 'rgba(0,0,0,0.5)', 0, true, true);
  return t;
}

/** Применить ко всем уже созданным текстам сцены. */
export function applyThickFont(scene: Phaser.Scene): void {
  scene.children.each((o: Phaser.GameObjects.GameObject) => {
    if (o instanceof Phaser.GameObjects.Text) thicken(o);
    return true;
  });
}

/** Толстый моноширинный текст комбинации с контуром. */
export function comboText(
  scene: Phaser.Scene,
  x: number,
  y: number,
  str: string,
  size: number,
  color: string,
  outline = 4,
): Phaser.GameObjects.Text {
  const t = scene.add.text(x, y, str, {
    fontFamily: COMBO_FONT_FAMILY,
    fontSize: `${size}px`,
    color,
    fontStyle: 'bold',
  });
  t.setStroke('rgba(0,0,0,0.75)', outline);
  return t;
}
