/*
 * État partagé entre les étapes de la page de test, et exécution des tests
 * (un seul à la fois, écran maintenu allumé, signal de fin pour les tests longs).
 */
import type { ScannedFile } from './analysis';
import { Journal } from './journal';
import { ScreenWakeLock, signalFinished, VIBRATION } from '../platform';
import type { FsaDirectoryBackend, ReadOnlySource } from '../storage';

/** Seul dossier créé (et supprimable) par la page de test sur le SSD. */
export const TEST_DIR = 'ESAM_test_etape0';

/** Clés IndexedDB des poignées de la page de test (distinctes de celles de l'appli). */
export const CARD_KEY = 'etape0-carte';
export const SSD_KEY = 'etape0-ssd';

export interface ScanResult {
  rootName: string;
  topLevelEntries: number;
  files: ScannedFile[];
  dirs: number;
  totalBytes: number;
  ms: number;
  /** Dossiers illisibles : chemin et erreur. */
  errors: string[];
}

export interface CardState {
  /**
   * Poignée de la carte, gardée uniquement pour l'identification (nom, isSameEntry)
   * et l'enregistrement dans IndexedDB. Toute lecture passe par `source`
   * (ReadOnlySource) : aucune écriture n'est faite avec cette poignée.
   */
  handle: FileSystemDirectoryHandle;
  source: ReadOnlySource;
  scan: ScanResult | null;
}

export interface SsdState {
  handle: FileSystemDirectoryHandle;
  backend: FsaDirectoryBackend;
}

type Listener = () => void;

class AppState {
  card: CardState | null = null;
  ssd: SsdState | null = null;
  readonly journal = new Journal();
  /** Appareil et navigateur, pour le résumé (complété par l'étape 0). */
  device = typeof navigator === 'undefined' ? 'inconnu' : navigator.userAgent;
  readonly #listeners = new Set<Listener>();

  onChange(listener: Listener): void {
    this.#listeners.add(listener);
  }

  changed(): void {
    for (const listener of this.#listeners) listener();
  }
}

export const state = new AppState();

const wakeLock = new ScreenWakeLock();
let busy = false;

/** Vrai pendant un test : les autres boutons sont désactivés. */
export function isBusy(): boolean {
  return busy;
}

function setButtonsDisabled(disabled: boolean): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('.btn-run')) button.disabled = disabled;
}

export interface RunOptions {
  /** Test long : écran maintenu allumé, notification et vibration à la fin. */
  long?: boolean;
  /** Titre de la notification de fin. */
  title?: string;
}

/**
 * Lance un test. `run` renvoie vrai si le test a réussi (pour choisir la
 * vibration de fin). Les erreurs non attrapées par le test sont renvoyées à
 * `onError` (affichage) puis la page reste utilisable.
 */
export async function runTest(options: RunOptions, run: () => Promise<boolean>, onError: (error: unknown) => void): Promise<void> {
  if (busy) return;
  busy = true;
  setButtonsDisabled(true);
  const started = performance.now();
  let ok = false;
  try {
    if (options.long) await wakeLock.acquire();
    ok = await run();
  } catch (error) {
    console.error(error);
    onError(error);
  } finally {
    if (options.long) await wakeLock.release();
    busy = false;
    setButtonsDisabled(false);
    if (options.long && performance.now() - started > 5000) {
      await signalFinished({
        title: options.title ?? 'Test terminé',
        body: ok ? 'Test terminé, résultat à lire sur la page.' : 'Test terminé avec une erreur, voir la page.',
        vibration: ok ? VIBRATION.success : VIBRATION.error,
        tag: 'esam-etape0',
      });
    }
  }
}

export function wakeLockActive(): boolean {
  return wakeLock.active;
}
