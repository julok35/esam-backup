/*
 * Journal des mesures (navigateur) : conservé dans localStorage pour survivre à un
 * rechargement, exportable en CSV (téléchargement ou menu de partage Android) et
 * en résumé texte (presse-papiers).
 */
import { buildSummary, csvFileName, parseJournal, toCsv, type JournalEntry, type ResultKind } from './journal-format';
import { rateMiBps } from './format';

const STORAGE_KEY = 'esam-etape0-journal';

export interface NewEntry {
  step: number;
  test: string;
  param?: string;
  bytes?: number | null;
  ms?: number | null;
  /** Débit imposé ; sinon calculé à partir de bytes et ms. */
  rate?: number | null;
  result: ResultKind;
  detail?: string;
}

type Listener = (entries: readonly JournalEntry[]) => void;

export class Journal {
  #entries: JournalEntry[];
  readonly #listeners = new Set<Listener>();
  #storageOk = true;

  constructor() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      this.#storageOk = false;
    }
    this.#entries = parseJournal(stored);
  }

  get entries(): readonly JournalEntry[] {
    return this.#entries;
  }

  /** Faux si localStorage est indisponible (navigation privée, stockage bloqué). */
  get persistent(): boolean {
    return this.#storageOk;
  }

  add(entry: NewEntry): JournalEntry {
    const bytes = entry.bytes ?? null;
    const ms = entry.ms ?? null;
    const full: JournalEntry = {
      ts: new Date().toISOString(),
      step: entry.step,
      test: entry.test,
      param: entry.param ?? '',
      bytes,
      ms: ms === null ? null : Math.round(ms * 10) / 10,
      rate: entry.rate !== undefined ? entry.rate : bytes !== null && ms !== null ? rateMiBps(bytes, ms) : null,
      result: entry.result,
      detail: entry.detail ?? '',
    };
    this.#entries.push(full);
    this.#save();
    return full;
  }

  clear(): void {
    this.#entries = [];
    this.#save();
  }

  onChange(listener: Listener): void {
    this.#listeners.add(listener);
    listener(this.#entries);
  }

  #save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#entries));
      this.#storageOk = true;
    } catch {
      this.#storageOk = false;
    }
    for (const listener of this.#listeners) listener(this.#entries);
  }

  csv(): string {
    return toCsv(this.#entries);
  }

  summary(device: string, build: string): string {
    return buildSummary(this.#entries, { now: new Date(), device, build });
  }
}

function csvFile(journal: Journal): File {
  return new File([journal.csv()], csvFileName(new Date()), { type: 'text/csv;charset=utf-8' });
}

/** Télécharge le CSV via un lien vers un Blob. */
export function downloadCsv(journal: Journal): string {
  const file = csvFile(journal);
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return file.name;
}

export function canShareCsv(): boolean {
  if (typeof navigator.canShare !== 'function' || typeof navigator.share !== 'function') return false;
  try {
    return navigator.canShare({ files: [new File(['x'], 'x.csv', { type: 'text/csv' })] });
  } catch {
    return false;
  }
}

/** Ouvre le menu de partage Android avec le CSV (mail, Drive, WhatsApp...). */
export async function shareCsv(journal: Journal): Promise<void> {
  const file = csvFile(journal);
  await navigator.share({ files: [file], title: 'ESAM étape 0', text: 'Résultats de la page de test ESAM (étape 0).' });
}

/** Copie un texte dans le presse-papiers, avec repli si l'API moderne manque. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copie refusée');
}
