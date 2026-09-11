import Phaser from 'phaser';
import { applyThickFont } from '../ui/font';

export class MenuScene extends Phaser.Scene {
  constructor() {
    super('Menu');
  }

  preload(): void {
    this.load.image('herro', 'assets/characters/Herro.png');
  }

  create(): void {
    const { width, height } = this.scale;
    this.cameras.main.setBackgroundColor('#1a2b1a');

    this.add
      .text(width / 2, height * 0.3, '🧙 THE KNIGHT', {
        fontSize: '40px',
        color: '#ffd76a',
      })
      .setOrigin(0.5);

    if (this.textures.exists('herro')) {
      const hero = this.add.image(width / 2, height * 0.42, 'herro');
      const src = this.textures.get('herro').getSourceImage() as { width: number; height: number };
      hero.setScale(110 / Math.max(src.width || 1, src.height || 1));
    }

    this.add
      .text(width / 2, height * 0.45, 'Combat Lab\nРазведай скрытые комбо\nТы бьешь первым', {
        fontSize: '22px',
        color: '#cfe8cf',
        align: 'center',
      })
      .setOrigin(0.5);

    const btn = this.add
      .rectangle(width / 2, height * 0.62, 280, 72, 0x2e7d32)
      .setStrokeStyle(3, 0xffffff)
      .setInteractive({ useHandCursor: true });

    this.add
      .text(width / 2, height * 0.62, 'TAP TO START', {
        fontSize: '24px',
        color: '#ffffff',
      })
      .setOrigin(0.5);

    btn.on('pointerup', () => this.scene.start('CombatLab'));
    this.input.once('pointerup', () => this.scene.start('CombatLab'));
    applyThickFont(this);
  }
}
