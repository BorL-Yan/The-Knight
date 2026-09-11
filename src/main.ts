import Phaser from 'phaser';
import './style.css';
import { MapTestScene } from './scenes/MapTestScene';
import { MenuScene } from './scenes/MenuScene';
import { CombatLabScene } from './scenes/CombatLabScene';
import { DungeonPreviewScene } from './scenes/DungeonPreviewScene';

// Референс 1080x1920 из документа, рендерим в половинном разрешении для перфа.
// Scale.FIT сохраняет пропорции на любом экране 360x640+.
function boot(): void {
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: 540,
    height: 960,
    backgroundColor: '#1a2b1a',
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    render: {
      antialias: false,
      pixelArt: true,
    },
    // TEST: игра сначала подключается к тестовому полю 7×14 (проверка движения).
    scene: [MapTestScene, MenuScene, CombatLabScene, DungeonPreviewScene],
  });
}

// Ждем загрузки жирного шрифта чтобы канвас-тексты запеклись сразу с ним.
async function waitForFonts(): Promise<void> {
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load('700 20px Rubik'),
        document.fonts.load('900 20px Rubik'),
        document.fonts.load('700 20px "JetBrains Mono"'),
        document.fonts.load('800 20px "JetBrains Mono"'),
      ]),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {
    /* fallback на системный шрифт */
  }
}

void waitForFonts().then(boot);
