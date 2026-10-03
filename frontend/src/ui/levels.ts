export type LevelMode = 'single' | 'multi';

/**
 * Vertical level selector: one or more chosen levels (Mode A, each with its own
 * level surface) or all levels stacked (Mode B). At least one level stays chosen.
 */
export class LevelSelector {
  private list: HTMLElement;
  private mode: LevelMode = 'single';
  private selected = new Set<number>();

  constructor(
    private root: HTMLElement,
    private onChange: (mode: LevelMode, levels: number[]) => void,
  ) {
    root.innerHTML = `
      <div class="seg" role="radiogroup" aria-label="Level mode">
        <button data-mode="single" class="on">Selected levels</button>
        <button data-mode="multi">All levels</button>
      </div>
      <div class="level-list" role="group" aria-label="Pressure levels"></div>`;
    this.list = root.querySelector('.level-list')!;
    root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => this.setMode(b.dataset.mode as LevelMode)),
    );
  }

  /** Chosen level indices, ascending. */
  get levels(): number[] {
    return [...this.selected].sort((a, b) => a - b);
  }

  /** @param levels hPa, @param heights mean geopotential height (m) per level */
  setLevels(levels: number[], heights: number[], selected: number[]): void {
    this.selected = new Set(selected);
    // highest level on top
    const order = levels.map((_, i) => i).sort((a, b) => levels[a] - levels[b]);
    this.list.innerHTML = order
      .map(
        (i) => `
        <label class="level-row">
          <input type="checkbox" value="${i}" ${this.selected.has(i) ? 'checked' : ''} />
          <span class="lv-p">${levels[i]} hPa</span>
          <span class="lv-h">≈ ${(heights[i] / 1000).toFixed(2)} km</span>
        </label>`,
      )
      .join('');
    this.list.querySelectorAll<HTMLInputElement>('input').forEach((inp) =>
      inp.addEventListener('change', () => {
        const i = parseInt(inp.value, 10);
        if (this.mode === 'multi') {
          // picking a level in all-levels mode starts a selection with just that level
          this.selected = new Set([i]);
          this.syncChecks();
          this.setMode('single');
          return;
        }
        if (inp.checked) this.selected.add(i);
        else if (this.selected.size > 1) this.selected.delete(i);
        else inp.checked = true; // keep at least one level
        this.onChange(this.mode, this.levels);
      }),
    );
    this.render();
  }

  setMode(mode: LevelMode): void {
    this.mode = mode;
    this.render();
    this.onChange(mode, this.levels);
  }

  private syncChecks(): void {
    this.list.querySelectorAll<HTMLInputElement>('input').forEach((inp) => {
      inp.checked = this.selected.has(parseInt(inp.value, 10));
    });
  }

  private render(): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.classList.toggle('on', b.dataset.mode === this.mode),
    );
    this.list.classList.toggle('dim', this.mode === 'multi');
  }
}
