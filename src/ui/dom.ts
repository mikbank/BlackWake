/**
 * Escape values interpolated into HTML so authored names, saves and radio facts cannot
 * inject markup.
 */
export const esc = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    /** Replace each HTML-sensitive character with its safe entity before markup insertion. */
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );
/**
 * Look up an existing DOM element using the caller's requested type; the TypeScript
 * assertion is not a runtime existence check.
 */
export const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
