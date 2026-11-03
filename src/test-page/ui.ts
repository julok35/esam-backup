/*
 * Briques d'interface de la page de test : étapes repliables, résultats,
 * barre de progression, erreurs détaillées, mesures brutes repliables.
 */
import { errorInfo } from './analysis';
import { etaMs, formatBytes, formatDuration, formatRate, percent } from './format';
import type { RateMeter } from './measure';
import { h, render } from '../ui/dom';

export type StatusKind = 'todo' | 'running' | 'ok' | 'fail' | 'na' | 'warn';

const STATUS_TEXT: Record<StatusKind, string> = {
  todo: 'À faire',
  running: 'En cours',
  ok: 'OK',
  fail: 'Échec',
  na: 'Non disponible',
  warn: 'À vérifier',
};

export function badge(kind: StatusKind, text = STATUS_TEXT[kind]): HTMLSpanElement {
  return h('span', { class: `badge badge-${kind}` }, text);
}

export interface Step {
  root: HTMLDetailsElement;
  body: HTMLDivElement;
  setStatus(kind: StatusKind, text?: string): void;
}

/** Étape repliable : le titre (zone d'appui large) porte le numéro et l'état. */
export function createStep(num: number, title: string, intro: string, open = false): Step {
  const status = h('span', { class: 'step-status' }, badge('todo'));
  const body = h('div', { class: 'step-body' }, h('p', { class: 'muted' }, intro));
  const root = h(
    'details',
    { class: 'step', id: `etape-${num}`, open },
    h('summary', {}, h('span', { class: 'step-num' }, String(num)), h('span', { class: 'step-title' }, title), status),
    body,
  );
  return {
    root,
    body,
    setStatus(kind, text) {
      render(status, badge(kind, text));
    },
  };
}

/** Gros bouton d'action. Les boutons « run » sont désactivés pendant un test. */
export function actionButton(label: string, onClick: () => void, variant: 'primary' | 'secondary' | 'danger' = 'primary'): HTMLButtonElement {
  const cls = variant === 'primary' ? 'btn btn-primary btn-run' : variant === 'danger' ? 'btn btn-danger btn-run' : 'btn btn-run';
  return h('button', { class: cls, type: 'button', onclick: () => onClick() }, label);
}

export interface Option<T extends string | number> {
  value: T;
  label: string;
}

/** Liste de choix avec étiquette. `read()` renvoie la valeur choisie. */
export function choice<T extends string | number>(label: string, options: readonly Option<T>[], initial: T): { el: HTMLLabelElement; read: () => T } {
  const select = h('select', { class: 'select' });
  for (const option of options) {
    const el = h('option', { value: String(option.value) }, option.label);
    if (option.value === initial) el.selected = true;
    select.append(el);
  }
  return {
    el: h('label', { class: 'field' }, h('span', {}, label), select),
    read: () => {
      const found = options.find((o) => String(o.value) === select.value);
      return found ? found.value : initial;
    },
  };
}

/** Zone de résultat : un verdict lisible, des lignes, et des mesures brutes repliables. */
export function resultArea(): { el: HTMLDivElement; show: (kind: StatusKind, title: string, lines?: readonly (string | Node)[], raw?: unknown) => void; append: (node: Node) => void; clear: () => void } {
  const el = h('div', { class: 'result', 'aria-live': 'polite' });
  return {
    el,
    show(kind, title, lines = [], raw) {
      render(
        el,
        h('div', { class: `status status-${kind === 'ok' ? 'ok' : kind === 'fail' ? 'error' : kind === 'running' || kind === 'todo' ? 'neutral' : 'warn'}` }, badge(kind), ' ', title),
        ...groupLines(lines),
        raw === undefined ? null : rawBlock(raw),
      );
    },
    append(node) {
      el.append(node);
    },
    clear() {
      render(el);
    },
  };
}

/** Les textes consécutifs forment une liste à puces ; les éléments (tableaux...) restent tels quels. */
function groupLines(lines: readonly (string | Node)[]): Node[] {
  const out: Node[] = [];
  let list: HTMLUListElement | null = null;
  for (const line of lines) {
    if (line === '') continue;
    if (typeof line === 'string') {
      list ??= h('ul', { class: 'lines' });
      list.append(h('li', {}, line));
      continue;
    }
    if (list) out.push(list);
    list = null;
    out.push(line);
  }
  if (list) out.push(list);
  return out;
}

/** Mesures brutes, repliées par défaut. */
export function rawBlock(raw: unknown, title = 'Mesures brutes'): HTMLDetailsElement {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
  return h('details', { class: 'raw' }, h('summary', {}, title), h('pre', { class: 'mono' }, text));
}

/** Bloc d'erreur : phrase en français, puis nom et message techniques. */
export function errorBlock(error: unknown, context?: string): HTMLDivElement {
  const info = errorInfo(error);
  return h(
    'div',
    { class: 'error-box' },
    h('p', { class: 'error-advice' }, info.advice),
    h('p', { class: 'mono' }, `${context ? `${context} : ` : ''}${info.name}`),
    h('p', { class: 'mono muted' }, info.message),
  );
}

export interface Progress {
  el: HTMLDivElement;
  start(label: string, total: number): void;
  update(done: number, meter: RateMeter): void;
  finish(): void;
}

/** Barre de progression avec débit instantané, débit moyen et temps restant. */
export function progressArea(): Progress {
  const bar = h('progress', { max: 100, value: 0 });
  const label = h('p', { class: 'progress-label' });
  const figures = h('p', { class: 'progress-figures mono' });
  const el = h('div', { class: 'progress', hidden: true }, label, bar, figures);
  let total = 0;
  let lastPaint = 0;
  return {
    el,
    start(text, totalBytes) {
      total = totalBytes;
      lastPaint = 0;
      el.hidden = false;
      label.textContent = text;
      bar.value = 0;
      figures.textContent = `0 / ${formatBytes(totalBytes)}`;
    },
    update(done, meter) {
      const now = performance.now();
      if (now - lastPaint < 250 && done < total) return;
      lastPaint = now;
      bar.value = percent(done, total);
      const instant = meter.instant();
      const eta = etaMs(done, total, meter.average());
      figures.textContent = `${percent(done, total)} % - ${formatBytes(done)} / ${formatBytes(total)} - ${formatRate(instant)} (moyenne ${formatRate(meter.average())})${eta === null ? '' : ` - reste ${formatDuration(eta)}`}`;
    },
    finish() {
      el.hidden = true;
    },
  };
}

/** Tableau simple clé / valeur. */
export function keyValueTable(rows: readonly [string, string | Node][]): HTMLTableElement {
  return h('table', { class: 'kv' }, h('tbody', {}, ...rows.map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, k), h('td', {}, v)))));
}
