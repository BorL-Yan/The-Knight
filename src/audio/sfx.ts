/** Минимальные бипы через WebAudio без ассетов — для CombatLab. */
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function beep(freq: number, durMs: number, type: OscillatorType = 'square', gain = 0.05): void {
  const ac = audio();
  if (!ac) return;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.value = gain;
  osc.connect(g);
  g.connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + durMs / 1000);
}

export const sfx = {
  swipe: () => beep(500, 40),
  correct: () => beep(760, 60),
  wrong: () => beep(160, 120, 'sawtooth'),
  hit: () => beep(220, 150, 'sawtooth', 0.08),
  perfect: () => {
    beep(880, 80);
    setTimeout(() => beep(1320, 120), 70);
  },
};
