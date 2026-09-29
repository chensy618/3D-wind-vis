const PLAY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';

/** Forecast timeline: play/pause, previous/next, drag, playback speed. */
export interface TimelineCallbacks {
  onTime(t: number): void;
  onPlay(playing: boolean): void;
  onRate(hoursPerSecond: number): void;
}

export class Timeline {
  private slider: HTMLInputElement;
  private label: HTMLElement;
  private valid: HTMLElement;
  private playBtn: HTMLButtonElement;
  private ticks: HTMLElement;
  private times: number[] = [];
  private initTime: Date | null = null;
  playing = false;

  constructor(
    root: HTMLElement,
    private cb: TimelineCallbacks,
  ) {
    root.innerHTML = `
      <div class="tl-buttons">
        <button data-act="prev" title="Previous forecast step (←)" aria-label="Previous"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg></button>
        <button data-act="play" title="Play / pause (space)" aria-label="Play"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z"/></svg></button>
        <button data-act="next" title="Next forecast step (→)" aria-label="Next"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg></button>
      </div>
      <div class="tl-track">
        <input type="range" min="0" max="24" step="0.05" value="0" aria-label="Forecast lead time" />
        <div class="tl-ticks"></div>
      </div>
      <div class="tl-readout">
        <div class="tl-lead"></div>
        <div class="tl-valid"></div>
      </div>
      <label class="tl-rate" title="Playback speed">
        <select aria-label="Playback speed">
          <option value="0.5">0.5 h/s</option>
          <option value="1" selected>1 h/s</option>
          <option value="2">2 h/s</option>
          <option value="4">4 h/s</option>
        </select>
      </label>`;
    this.slider = root.querySelector('input')!;
    this.label = root.querySelector('.tl-lead')!;
    this.valid = root.querySelector('.tl-valid')!;
    this.ticks = root.querySelector('.tl-ticks')!;
    this.playBtn = root.querySelector('[data-act="play"]')!;

    this.slider.addEventListener('input', () => {
      this.setPlaying(false);
      cb.onTime(parseFloat(this.slider.value));
    });
    root.querySelector('[data-act="prev"]')!.addEventListener('click', () => this.step(-1));
    root.querySelector('[data-act="next"]')!.addEventListener('click', () => this.step(1));
    this.playBtn.addEventListener('click', () => this.setPlaying(!this.playing));
    root.querySelector('select')!.addEventListener('change', (e) =>
      cb.onRate(parseFloat((e.target as HTMLSelectElement).value)),
    );
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.setPlaying(!this.playing);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        this.step(-1);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        this.step(1);
      }
    });
  }

  setData(times: number[], initTime: string): void {
    this.times = times;
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})/.exec(initTime);
    this.initTime = m ? new Date(`${m[1]}T${m[2]}:00:00Z`) : null;
    this.slider.min = String(times[0]);
    this.slider.max = String(times[times.length - 1]);
    const span = times[times.length - 1] - times[0] || 1;
    this.ticks.innerHTML = times
      .map((t) => `<span style="left:${((t - times[0]) / span) * 100}%">${String(t).padStart(2, '0')} h</span>`)
      .join('');
  }

  /** Jump to the previous/next forecast frame. */
  step(dir: number): void {
    this.setPlaying(false);
    const t = parseFloat(this.slider.value);
    const eps = 1e-6;
    const target =
      dir > 0
        ? this.times.find((x) => x > t + eps) ?? this.times[this.times.length - 1]
        : [...this.times].reverse().find((x) => x < t - eps) ?? this.times[0];
    this.cb.onTime(target);
  }

  setPlaying(p: boolean): void {
    if (p === this.playing) return;
    this.playing = p;
    this.playBtn.innerHTML = p ? PAUSE_ICON : PLAY_ICON;
    this.playBtn.setAttribute('aria-label', p ? 'Pause' : 'Play');
    this.cb.onPlay(p);
  }

  setTime(t: number): void {
    this.slider.value = String(t);
    this.label.textContent = `T+${t.toFixed(1).replace(/\.0$/, '')} h`;
    if (this.initTime) {
      const v = new Date(this.initTime.getTime() + t * 3600e3);
      this.valid.textContent = `valid ${v.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    } else {
      this.valid.textContent = '';
    }
  }
}
