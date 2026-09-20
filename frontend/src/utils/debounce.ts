/**
 * Returns a debounced version of fn that only runs after waitMs have passed
 * without another call. Used to coalesce rapid UI events (sliders, keystrokes)
 * into a single API request.
 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}
