/*
 * Étape 1 : lecture de la carte. La carte est ouverte en ReadOnlySource
 * (lecture seule) : la page ne peut rien écrire dessus.
 */
import { errorDetail, extensionStats, isLikelyRJpeg, largestFile, M30T_EXTENSIONS, type ScannedFile } from './analysis';
import { CARD_KEY, runTest, state, type ScanResult } from './context';
import { formatBytes, formatDuration, formatRateOf } from './format';
import { CRITICAL_TESTS } from './journal-format';
import { measureRead, pickDirectory, scanStorage } from './ops';
import { actionButton, createStep, errorBlock, keyValueTable, progressArea, resultArea, type Step } from './ui';
import { saveHandle } from '../platform';
import { ReadOnlySource } from '../storage';
import { h } from '../ui/dom';

const STEP = 1;

function scanLines(scan: ScanResult): (string | Node)[] {
  const stats = extensionStats(scan.files);
  const found = new Set(stats.map((s) => s.ext));
  const rjpeg = scan.files.filter((f) => isLikelyRJpeg(f.name)).length;
  const m30t = M30T_EXTENSIONS.map((ext) => `${ext.toUpperCase()} ${found.has(ext) ? 'oui' : 'non'}`).join(', ');
  const biggest = largestFile(scan.files);
  return [
    keyValueTable([
      ['Nom du dossier choisi', scan.rootName],
      ['Entrées au premier niveau', String(scan.topLevelEntries)],
      ['Fichiers', String(scan.files.length)],
      ['Dossiers', String(scan.dirs)],
      ['Volume total', formatBytes(scan.totalBytes)],
      ['Durée du parcours', formatDuration(scan.ms)],
      ['Plus gros fichier', biggest ? `${biggest.path} (${formatBytes(biggest.size)})` : 'aucun'],
      ['Formats du M30T', `${m30t}, R-JPEG ${rjpeg > 0 ? `oui (${rjpeg})` : 'non'}`],
    ]),
    h('p', {}, 'Extensions rencontrées :'),
    h('ul', { class: 'lines' }, ...stats.map((s) => h('li', {}, `.${s.ext} : ${s.count} fichier(s), ${formatBytes(s.bytes)}`))),
    scan.errors.length > 0 ? h('p', { class: 'warn-text' }, `${scan.errors.length} dossier(s) illisible(s), détail dans les mesures brutes.`) : '',
  ];
}

/** Parcourt la carte et enregistre le résultat. Renvoie le parcours, ou null en cas d'échec. */
export async function scanCard(onStatus: (text: string) => void): Promise<ScanResult | null> {
  const card = state.card;
  if (!card) return null;
  const scan = await scanStorage(card.source, (files, bytes) => onStatus(`Parcours : ${files} fichiers, ${formatBytes(bytes)}...`));
  card.scan = scan;
  state.journal.add({
    step: STEP,
    test: 'parcours récursif',
    param: scan.rootName,
    bytes: scan.totalBytes,
    ms: scan.ms,
    rate: null,
    result: scan.errors.length === 0 ? 'OK' : 'ECHEC',
    detail: `${scan.files.length} fichiers, ${scan.dirs} dossiers, ${scan.topLevelEntries} entrées au premier niveau, extensions ${extensionStats(scan.files)
      .map((s) => `${s.ext}:${s.count}`)
      .join(' ')}${scan.errors.length > 0 ? `, erreurs: ${scan.errors.join(' | ')}` : ''}`,
  });
  state.changed();
  return scan;
}

export function createCardStep(fallbackOpen: boolean): Step {
  const step = createStep(
    STEP,
    'Lecture de la carte',
    "Branchez le hub, le lecteur et la carte. Choisissez le dossier racine de la carte (ou son dossier DCIM si Chrome refuse la racine). La carte est ouverte en lecture seule : la page ne peut rien y écrire.",
  );
  const result = resultArea();
  const progress = progressArea();
  const readResult = resultArea();

  const readButton = actionButton('Lire en entier le plus gros fichier', () => {
    void runTest({ long: true, title: 'Lecture de la carte terminée' }, () => readLargest(), (e) => readResult.show('fail', 'Erreur inattendue', [errorBlock(e)]));
  });
  readButton.hidden = true;

  async function pick(): Promise<boolean> {
    result.show('running', 'Choix du dossier...');
    readResult.clear();
    let handle: FileSystemDirectoryHandle;
    let startIn: string;
    try {
      ({ handle, startIn } = await pickDirectory('read', 'esam-carte'));
    } catch (error) {
      const aborted = typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
      step.setStatus(aborted ? 'warn' : 'fail', aborted ? 'Annulé' : 'Échec');
      result.show(aborted ? 'warn' : 'fail', aborted ? 'Choix annulé.' : 'Impossible de choisir le dossier de la carte.', [errorBlock(error, 'showDirectoryPicker')]);
      state.journal.add({ step: STEP, test: 'choix dossier carte', param: 'mode read', result: aborted ? 'INFO' : 'ECHEC', detail: errorDetail(error) });
      return false;
    }
    const source = new ReadOnlySource(handle);
    state.card = { handle, source, scan: null };
    // Premières entrées du dossier choisi : pour comprendre ce qu'est un dossier nommé « media ».
    let topLevel: string;
    try {
      const top = await source.list('');
      const names = top.slice(0, 10).map((e) => (e.kind === 'directory' ? `${e.name}/` : e.name));
      topLevel = `premier niveau (${top.length} entrées) : ${names.join(' | ') || 'vide'}${top.length > 10 ? ' | ...' : ''}`;
    } catch (error) {
      topLevel = `premier niveau illisible : ${errorDetail(error)}`;
    }
    state.journal.add({ step: STEP, test: 'choix dossier carte', param: 'mode read', result: 'OK', detail: `nom=${handle.name} startIn=${startIn} ; ${topLevel}` });
    try {
      await saveHandle(CARD_KEY, handle);
      state.journal.add({ step: 5, test: 'enregistrement poignée carte', result: 'OK', detail: handle.name });
    } catch (error) {
      state.journal.add({ step: 5, test: 'enregistrement poignée carte', result: 'ECHEC', detail: errorDetail(error) });
    }
    state.changed();
    step.setStatus('running');
    let scan: ScanResult | null;
    try {
      scan = await scanCard((text) => result.show('running', text));
    } catch (error) {
      step.setStatus('fail');
      result.show('fail', 'La carte a été choisie mais son contenu ne se lit pas.', [errorBlock(error, 'parcours')]);
      state.journal.add({ step: STEP, test: CRITICAL_TESTS.cardRead.test, result: 'ECHEC', detail: `parcours impossible : ${errorDetail(error)}` });
      return false;
    }
    if (!scan) return false;
    const biggest = largestFile(scan.files);
    result.show(
      scan.files.length > 0 && scan.errors.length === 0 ? 'ok' : 'warn',
      scan.files.length > 0 ? `Carte lue : ${scan.files.length} fichiers, ${formatBytes(scan.totalBytes)}.` : 'Aucun fichier trouvé dans ce dossier.',
      scanLines(scan),
      { racine: scan.rootName, startIn, erreurs: scan.errors, fichiers: scan.files.slice(0, 200), tronque: scan.files.length > 200 },
    );
    readButton.hidden = biggest === null;
    if (biggest) {
      readButton.textContent = `Lire en entier le plus gros fichier (${formatBytes(biggest.size)})`;
      // Une seule action principale : la lecture passe devant, le choix devient secondaire.
      pickButton.classList.remove('btn-primary');
      pickButton.textContent = 'Rechoisir le dossier de la carte';
      readButton.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    step.setStatus(scan.files.length > 0 ? 'warn' : 'fail', scan.files.length > 0 ? 'Lecture à faire' : 'Vide');
    return true;
  }

  async function readLargest(): Promise<boolean> {
    const card = state.card;
    const biggest = card?.scan ? largestFile(card.scan.files) : null;
    if (!card || !biggest) {
      readResult.show('na', "Choisissez d'abord la carte.");
      return false;
    }
    readResult.show('running', `Lecture de ${biggest.path}...`);
    step.setStatus('running');
    try {
      const input = await card.source.openRead(biggest.path);
      progress.start(`Lecture de ${biggest.name}`, input.size);
      const m = await measureRead(input.stream, false, (done, meter) => progress.update(done, meter));
      progress.finish();
      const complete = m.bytes === input.size;
      state.journal.add({
        step: STEP,
        test: CRITICAL_TESTS.cardRead.test,
        param: biggest.name,
        bytes: m.bytes,
        ms: m.ms,
        result: complete ? 'OK' : 'ECHEC',
        detail: `attendu ${input.size} octets, morceaux natifs ${m.native.count} (moyenne ${Math.round(m.native.mean)} octets, max ${m.native.max})`,
      });
      step.setStatus(complete ? 'ok' : 'fail');
      readResult.show(
        complete ? 'ok' : 'fail',
        complete ? `Fichier lu en entier : ${formatRateOf(m.bytes, m.ms)}.` : `Lecture incomplète : ${formatBytes(m.bytes)} sur ${formatBytes(input.size)}.`,
        [
          keyValueTable([
            ['Fichier', biggest.path],
            ['Taille', formatBytes(m.bytes)],
            ['Durée', formatDuration(m.ms)],
            ['Débit', formatRateOf(m.bytes, m.ms)],
            ['Morceaux lus par Chrome', `${m.native.count}, en moyenne ${formatBytes(m.native.mean)}`],
          ]),
        ],
        m,
      );
      return complete;
    } catch (error) {
      progress.finish();
      step.setStatus('fail');
      readResult.show('fail', 'La lecture du fichier a échoué.', [errorBlock(error, 'lecture')]);
      state.journal.add({ step: STEP, test: CRITICAL_TESTS.cardRead.test, param: biggest.name, result: 'ECHEC', detail: errorDetail(error) });
      return false;
    }
  }

  const pickButton = actionButton('Choisir le dossier de la carte', () => {
    void runTest({}, () => pick(), (e) => result.show('fail', 'Erreur inattendue', [errorBlock(e)]));
  });

  step.body.append(pickButton, result.el, readButton, progress.el, readResult.el, createFallback(fallbackOpen));
  return step;
}

/** Repli sans showDirectoryPicker : sélection de fichiers classique, pour mesurer au moins la lecture. */
function createFallback(open: boolean): HTMLDetailsElement {
  const result = resultArea();
  const progress = progressArea();
  const dirInput = h('input', { type: 'file', multiple: true, class: 'visually-hidden', id: 'repli-dossier' });
  dirInput.setAttribute('webkitdirectory', '');
  const filesInput = h('input', { type: 'file', multiple: true, class: 'visually-hidden', id: 'repli-fichiers' });

  const handle = (input: HTMLInputElement, mode: string) => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length === 0) {
      result.show('warn', 'Aucun fichier choisi.');
      return;
    }
    void runTest({ long: true, title: 'Lecture (repli) terminée' }, () => readFallback(files, mode), (e) => result.show('fail', 'Erreur inattendue', [errorBlock(e)]));
  };
  dirInput.addEventListener('change', () => handle(dirInput, 'input webkitdirectory'));
  filesInput.addEventListener('change', () => handle(filesInput, 'input multiple'));

  async function readFallback(files: File[], mode: string): Promise<boolean> {
    const scanned: ScannedFile[] = files.map((f) => ({ path: f.webkitRelativePath || f.name, name: f.name, size: f.size, lastModified: f.lastModified }));
    const total = scanned.reduce((s, f) => s + f.size, 0);
    const biggestIndex = scanned.reduce((best, f, i) => (f.size > (scanned[best]?.size ?? -1) ? i : best), 0);
    const file = files[biggestIndex];
    if (!file) return false;
    state.journal.add({ step: STEP, test: 'liste repli', param: mode, bytes: total, result: 'INFO', detail: `${files.length} fichiers, extensions ${extensionStats(scanned).map((s) => `${s.ext}:${s.count}`).join(' ')}` });
    progress.start(`Lecture de ${file.name}`, file.size);
    try {
      const m = await measureRead(file.stream() as ReadableStream<Uint8Array>, false, (done, meter) => progress.update(done, meter));
      progress.finish();
      state.journal.add({ step: STEP, test: 'lecture repli (input)', param: `${mode}, ${file.name}`, bytes: m.bytes, ms: m.ms, result: m.bytes === file.size ? 'OK' : 'ECHEC', detail: 'repli, pas l\'architecture cible' });
      result.show('ok', `Lecture par le repli : ${formatRateOf(m.bytes, m.ms)}.`, [
        `${files.length} fichiers, ${formatBytes(total)} au total (${mode}).`,
        `Plus gros fichier : ${file.name}, ${formatBytes(file.size)}, lu en ${formatDuration(m.ms)}.`,
        "Rappel : ce repli ne donne pas accès au dossier en écriture ni aux poignées conservées. Ce n'est pas l'architecture cible.",
      ], m);
      return true;
    } catch (error) {
      progress.finish();
      state.journal.add({ step: STEP, test: 'lecture repli (input)', param: mode, result: 'ECHEC', detail: errorDetail(error) });
      result.show('fail', 'Lecture par le repli impossible.', [errorBlock(error)]);
      return false;
    }
  }

  const details = h(
    'details',
    { class: 'fallback', open },
    h('summary', {}, 'Repli sans choix de dossier (pas l\'architecture cible)'),
    h('p', { class: 'muted' }, "À utiliser seulement si le bouton ci-dessus ne fonctionne pas. Mesure la lecture des fichiers choisis, sans accès durable au dossier."),
    h('label', { class: 'btn', for: 'repli-dossier' }, 'Repli 1 : choisir un dossier entier'),
    dirInput,
    h('label', { class: 'btn', for: 'repli-fichiers' }, 'Repli 2 : choisir des fichiers'),
    filesInput,
    progress.el,
    result.el,
  );
  return details;
}
