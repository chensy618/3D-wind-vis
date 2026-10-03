/** Bounds of the domain that a query must fall inside, degrees. */
export interface QueryBounds {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

/**
 * Point query: "lat, lon" in decimal degrees → onQuery(lat, lon).
 * Accepts commas or spaces and optional N/E letters; if the two numbers are
 * clearly lon, lat (as they are around Senja, where the ranges do not overlap),
 * they are swapped.
 */
export class PointQuery {
  private input: HTMLInputElement;
  private msg: HTMLElement;
  private bounds: QueryBounds | null = null;

  constructor(
    root: HTMLElement,
    private onQuery: (lat: number, lon: number) => void,
  ) {
    root.innerHTML = `
      <form class="query" autocomplete="off">
        <input type="text" inputmode="decimal" aria-label="Latitude, longitude" placeholder="69.35, 17.60" />
        <button type="submit">Go</button>
      </form>
      <div class="desc small query-msg"></div>`;
    this.input = root.querySelector('input')!;
    this.msg = root.querySelector('.query-msg')!;
    root.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
  }

  setBounds(b: QueryBounds): void {
    this.bounds = b;
    this.hint();
  }

  private hint(): void {
    const b = this.bounds;
    this.msg.classList.remove('error');
    this.msg.textContent = b
      ? `Latitude, longitude inside ${b.latMin.toFixed(2)}–${b.latMax.toFixed(2)}° N, ${b.lonMin.toFixed(2)}–${b.lonMax.toFixed(2)}° E`
      : '';
  }

  private error(text: string): void {
    this.msg.classList.add('error');
    this.msg.textContent = text;
  }

  private submit(): void {
    const nums = (this.input.value.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (nums.length !== 2) {
      this.error('Enter latitude and longitude, e.g. 69.35, 17.60');
      return;
    }
    let [lat, lon] = nums;
    const b = this.bounds;
    if (b) {
      const inLat = (v: number) => v >= b.latMin && v <= b.latMax;
      const inLon = (v: number) => v >= b.lonMin && v <= b.lonMax;
      if (!(inLat(lat) && inLon(lon)) && inLat(lon) && inLon(lat)) [lat, lon] = [lon, lat];
      if (!(inLat(lat) && inLon(lon))) {
        this.error(`${lat}, ${lon} is outside the domain (${b.latMin.toFixed(2)}–${b.latMax.toFixed(2)}° N, ${b.lonMin.toFixed(2)}–${b.lonMax.toFixed(2)}° E)`);
        return;
      }
    }
    this.hint();
    this.onQuery(lat, lon);
  }
}
