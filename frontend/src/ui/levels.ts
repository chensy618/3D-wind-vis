import { SURFACE_LEVEL } from '../wind/advection';

/** What to render for the 10 m above-ground wind; omitted when the caller has no such concept. */
export interface SurfaceOption {
  /** the dataset has a 10 m wind (u10/v10); false renders the row greyed out and unselectable */
  available: boolean;
  checked: boolean;
}

/**
 * One checkbox for the 10 m wind (as a flat 10 m ASL level) on top, then one per pressure/height
 * level, highest level first, under an "All layers" button that checks them all. The levels start
 * checked. Unchecking the last remaining layer is refused, so at least one layer always stays on.
 * `onChange` receives the checked pressure-level indices (ascending) and whether the 10 m layer is on.
 */
export function renderLevelPicker(
  root: HTMLElement,
  levels: number[],
  heights: number[],
  onChange: (selected: number[], surface: boolean) => void,
  unit = 'hPa',
  surface?: SurfaceOption,
): void {
  const order = levels.map((_, i) => i).sort((a, b) => heights[b] - heights[a]);
  const rows = order.map(
    (i) => `
      <label class="level-row">
        <input type="checkbox" value="${i}" checked />
        <span class="lv-p">${levels[i]} ${unit}</span>
        <span class="lv-h">≈ ${(heights[i] / 1000).toFixed(2)} km</span>
      </label>`,
  );
  if (surface) {
    rows.unshift(`
      <label class="level-row${surface.available ? '' : ' off'}" title="${surface.available ? '' : 'This dataset has no 10 m wind'}">
        <input type="checkbox" value="${SURFACE_LEVEL}"${surface.available ? '' : ' disabled'}${surface.checked && surface.available ? ' checked' : ''} />
        <span class="lv-p">10 m ASL</span>
        <span class="lv-h">10 m wind</span>
      </label>`);
  }
  root.innerHTML = `<button type="button" class="wide lv-all">All layers</button>${rows.join('')}`;
  const boxes = [...root.querySelectorAll<HTMLInputElement>('input')].filter((b) => !b.disabled);
  const emit = () => {
    const selected = boxes
      .filter((b) => b.checked && Number(b.value) !== SURFACE_LEVEL)
      .map((b) => parseInt(b.value, 10))
      .sort((a, b) => a - b);
    const on10m = boxes.some((b) => b.checked && Number(b.value) === SURFACE_LEVEL);
    if (!selected.length && !on10m) return false;
    onChange(selected, on10m);
    return true;
  };
  for (const box of boxes) {
    box.addEventListener('change', () => {
      if (!emit()) box.checked = true; // keep at least one layer on
    });
  }
  // one click turns every layer on, the 10 m layer too when the dataset has it
  root.querySelector('.lv-all')!.addEventListener('click', () => {
    for (const b of boxes) b.checked = true;
    emit();
  });
}
