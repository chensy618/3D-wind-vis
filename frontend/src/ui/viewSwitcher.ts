export type ViewId = 'viewer' | 'compare';

const VIEWS: { id: ViewId; href: string; label: string; title: string }[] = [
  { id: 'viewer', href: './index.html', label: '3D wind viewer', title: 'Pressure levels and the 10 m surface wind in 3D' },
  { id: 'compare', href: './compare.html', label: 'Forecast vs WindINR', title: 'Model raw output next to WindINR' },
];

/** Top-middle view switcher; the entry for `current` is marked active. */
export function renderViewSwitcher(root: HTMLElement, current: ViewId): void {
  root.innerHTML = VIEWS.map(
    (v) =>
      `<a href="${v.href}" title="${v.title}"${v.id === current ? ' class="on" aria-current="page"' : ''}>${v.label}</a>`,
  ).join('');
}
