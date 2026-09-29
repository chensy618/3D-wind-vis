export type LevelMode = 'single' | 'multi';

/** Vertical level selector: single-level (Mode A) or multi-level (Mode B). */
export class LevelSelector {
  private list: HTMLElement;
  private mode: LevelMode = 'single';
  private selected = 0;

  constructor(
    private root: HTMLElement,
    private onChange: (mode: LevelMode, level: number) => void,
  ) {
    root.innerHTML = `
      <div class="seg" role="radiogroup" aria-label="Level mode">
        <button data-mode="single" class="on">Single level</button>
        <button data-mode="multi">All levels</button>
      </div>
      <div class="level-list" role="radiogroup" aria-label="Pressure level"></div>`;
    this.list = root.querySelector('.level-list')!;
    root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => this.setMode(b.dataset.mode as LevelMode)),
    );
  }

  /** @param levels hPa, @param heights mean geopotential height (m) per level */
  setLevels(levels: number[], heights: number[], selected: number): void {
    this.selected = selected;
    // highest level on top
    const order = levels.map((_, i) => i).sort((a, b) => levels[a] - levels[b]);
    this.list.innerHTML = order
      .map(
        (i) => `
        <label class="level-row">
          <input type="radio" name="level" value="${i}" ${i === selected ? 'checked' : ''} />
          <span class="lv-p">${levels[i]} hPa</span>
          <span class="lv-h">≈ ${(heights[i] / 1000).toFixed(2)} km</span>
        </label>`,
      )
      .join('');
    this.list.querySelectorAll<HTMLInputElement>('input').forEach((inp) =>
      inp.addEventListener('change', () => {
        this.selected = parseInt(inp.value, 10);
        if (this.mode === 'multi') this.setMode('single');
        else this.onChange(this.mode, this.selected);
      }),
    );
    this.render();
  }

  setMode(mode: LevelMode): void {
    this.mode = mode;
    this.render();
    this.onChange(mode, this.selected);
  }

  private render(): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.classList.toggle('on', b.dataset.mode === this.mode),
    );
    this.list.classList.toggle('dim', this.mode === 'multi');
  }
}
