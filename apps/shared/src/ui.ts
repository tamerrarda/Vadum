// The whole UI layer both apps share: a render function, a handful of element builders, and one
// stylesheet. No framework — every dependency in an offline wallet is one more thing to precache and
// audit (20-ARCHITECTURE.md).

export const STYLES = `
  :root { color-scheme: dark; --bg: #0b0b0f; --fg: #e7e7ea; --muted: #9a9aa6; --line: #23232b;
          --ok: #7ee787; --warn: #f0c674; --bad: #ff7b72; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 system-ui, sans-serif;
         padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom)); }
  main { max-width: 460px; margin: 0 auto; display: grid; gap: 16px; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 17px; margin: 0; }
  p { margin: 0; color: var(--muted); }
  .card { border: 1px solid var(--line); border-radius: 14px; padding: 16px; display: grid; gap: 10px; }
  .row { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .row span:last-child { font-variant-numeric: tabular-nums; text-align: right; }
  .amount { font-size: 34px; font-weight: 650; letter-spacing: -0.02em; }
  button { font: inherit; font-weight: 600; padding: 14px 16px; border-radius: 12px; border: 1px solid var(--line);
           background: #16161d; color: var(--fg); width: 100%; }
  button.primary { background: var(--ok); color: #08130a; border-color: transparent; }
  button:disabled { opacity: 0.5; }
  input { font: inherit; padding: 14px; border-radius: 12px; border: 1px solid var(--line); background: #16161d;
          color: var(--fg); width: 100%; }
  img.qr { width: 100%; max-width: 320px; image-rendering: pixelated; border-radius: 12px; background: #fff; }
  video { width: 100%; border-radius: 12px; background: #000; aspect-ratio: 3 / 4; object-fit: cover; }
  .muted { color: var(--muted); font-size: 14px; }
  .warn { color: var(--warn); }
  .bad { color: var(--bad); }
  .ok { color: var(--ok); }
  code { font-family: ui-monospace, monospace; font-size: 13px; word-break: break-all; }
`;

let root: HTMLElement | null = null;

/** Installs the stylesheet once and remembers the mount point. */
export function mount(selector = '#app'): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`no element matches ${selector}`);
  if (document.querySelector('#vadum-styles') === null) {
    const style = document.createElement('style');
    style.id = 'vadum-styles';
    style.textContent = STYLES;
    document.head.append(style);
  }
  root = element;
  return element;
}

/** Replaces the screen. Text is always set through `textContent`, never interpolated into HTML. */
export function render(...nodes: readonly Node[]): void {
  if (root === null) throw new Error('render() before mount()');
  const main = document.createElement('main');
  main.append(...nodes);
  root.replaceChildren(main);
}

type Attributes = Record<string, string | undefined>;

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  children: readonly (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) if (value !== undefined) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

export const text = (tag: 'h1' | 'h2' | 'p' | 'span' | 'code' | 'div', content: string, className?: string): HTMLElement =>
  element(tag, { class: className }, [content]);

export const card = (...children: readonly (Node | string)[]): HTMLElement => element('div', { class: 'card' }, children);

export const row = (label: string, value: string, valueClass?: string): HTMLElement =>
  element('div', { class: 'row' }, [text('span', label, 'muted'), text('span', value, valueClass)]);

export function button(label: string, onClick: () => void | Promise<void>, options: { primary?: boolean; disabled?: boolean } = {}): HTMLButtonElement {
  const node = element('button', { class: options.primary === true ? 'primary' : undefined });
  node.textContent = label;
  node.disabled = options.disabled === true;
  node.addEventListener('click', () => {
    node.disabled = true;
    void Promise.resolve(onClick()).finally(() => {
      node.disabled = options.disabled === true;
    });
  });
  return node;
}

/** A QR code with its payload length: the measurement report cares, and so does a demo caption. */
export function qrImage(dataUrl: string, caption: string): HTMLElement {
  return element('div', { class: 'card' }, [element('img', { class: 'qr', src: dataUrl, alt: caption }), text('p', caption, 'muted')]);
}
