/** Window size the panels are laid out for; a smaller window shrinks them all alike instead of reflowing. */
const DESIGN_W = 1400;
const DESIGN_H = 800;
/** Phones keep their own stacked layout (style.css, max-width: 760px). */
const PHONE_MAX_W = 760;

/** Scale the #ui layer to the window: the same layout on every screen, never larger than designed. */
export function fitUi(): void {
  const apply = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const s = w <= PHONE_MAX_W ? 1 : Math.min(1, w / DESIGN_W, h / DESIGN_H);
    document.documentElement.style.setProperty('--ui-scale', String(s));
  };
  window.addEventListener('resize', apply);
  apply();
}
