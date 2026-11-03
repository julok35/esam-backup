/*
 * Étape 5 : les poignées conservées dans IndexedDB restent-elles utilisables
 * après débranchement, rechargement de la page ou fermeture de Chrome ?
 * Au chargement, la page relit les poignées enregistrées et affiche leur état
 * sans rien demander.
 */
import { errorDetail } from './analysis';
import { CARD_KEY, runTest, SSD_KEY, state, TEST_DIR } from './context';
import { formatDuration } from './format';
import { measureRead, streamChunks } from './ops';
import { actionButton, badge, choice, createStep, errorBlock, keyValueTable, resultArea, type StatusKind, type Step } from './ui';
import { checkHandle, loadHandle, saveHandle, type AccessMode, type HandleCheck } from '../platform';
import { FsaDirectoryBackend, joinPath, ReadOnlySource, type ReadableStorage } from '../storage';
import { h, render } from '../ui/dom';

const STEP = 5;

type Scenario = 'debranchement-carte' | 'debranchement-ssd' | 'rechargement' | 'fermeture-chrome' | 'redemarrage' | 'libre';

const SCENARIOS: { value: Scenario; label: string; instructions: string }[] = [
  {
    value: 'debranchement-carte',
    label: 'Débrancher et rebrancher la carte',
    instructions: 'Retirez la carte du lecteur (ou débranchez le lecteur), attendez 5 secondes, remettez-la, attendez que le téléphone la reconnaisse, puis appuyez sur « Vérifier maintenant ».',
  },
  {
    value: 'debranchement-ssd',
    label: 'Débrancher et rebrancher le SSD',
    instructions: 'Débranchez le SSD du hub, attendez 5 secondes, rebranchez-le, attendez que le téléphone le reconnaisse, puis appuyez sur « Vérifier maintenant ».',
  },
  {
    value: 'rechargement',
    label: 'Recharger la page',
    instructions: "Rechargez la page (menu de Chrome, flèche circulaire). Au retour, l'état ci-dessous s'affiche tout seul. Choisissez à nouveau ce scénario puis appuyez sur « Vérifier maintenant ».",
  },
  {
    value: 'fermeture-chrome',
    label: 'Fermer Chrome et le rouvrir',
    instructions: "Fermez Chrome complètement (bouton des applis récentes, balayer Chrome), rouvrez-le sur cette page. L'état s'affiche tout seul. Choisissez à nouveau ce scénario puis appuyez sur « Vérifier maintenant ».",
  },
  {
    value: 'redemarrage',
    label: 'Redémarrer le téléphone',
    instructions: 'Redémarrez le téléphone, rebranchez tout, rouvrez cette page, choisissez ce scénario puis appuyez sur « Vérifier maintenant ».',
  },
  { value: 'libre', label: 'Autre situation (à décrire dans vos notes)', instructions: 'Faites la manipulation, puis appuyez sur « Vérifier maintenant ».' },
];

const STATE_KIND: Record<HandleCheck['state'], StatusKind> = {
  ok: 'ok',
  'permission-needed': 'warn',
  missing: 'fail',
  unavailable: 'fail',
  error: 'fail',
};

/** Cherche un fichier à lire (parcours en largeur, 3 niveaux au plus). */
async function firstFile(storage: ReadableStorage): Promise<string | null> {
  let level = [''];
  for (let depth = 0; depth < 3 && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      const entries = await storage.list(dir);
      const file = entries.find((e) => e.kind === 'file');
      if (file) return joinPath(dir, file.name);
      next.push(...entries.filter((e) => e.kind === 'directory').map((e) => joinPath(dir, e.name)));
    }
    level = next.slice(0, 20);
  }
  return null;
}

/** Lit au plus `limit` octets du début d'un fichier. */
async function readHead(storage: ReadableStorage, path: string, limit: number): Promise<number> {
  const input = await storage.openRead(path);
  let bytes = 0;
  for await (const chunk of streamChunks(input.stream)) {
    bytes += chunk.byteLength;
    if (bytes >= limit) break;
  }
  await input.stream.cancel().catch(() => undefined);
  return bytes;
}

export function createPersistenceStep(): Step {
  const step = createStep(
    STEP,
    'Persistance des poignées',
    "Vérifie que le téléphone se souvient de la carte et du SSD sans les redemander, après débranchement, rechargement de la page ou fermeture de Chrome. Les poignées sont enregistrées dès que vous choisissez un dossier aux étapes 1 et 2.",
  );
  const atLoad = h('div', { class: 'at-load' }, h('p', { class: 'muted' }, 'Lecture des poignées enregistrées...'));
  const scenario = choice<Scenario>('Scénario testé', SCENARIOS, 'debranchement-carte');
  const instructions = h('p', { class: 'instructions' });
  const showInstructions = () => {
    instructions.textContent = SCENARIOS.find((s) => s.value === scenario.read())?.instructions ?? '';
  };
  scenario.el.querySelector('select')?.addEventListener('change', showInstructions);
  showInstructions();
  const result = resultArea();
  const saveResult = resultArea();

  /** État au chargement : sans aucune demande d'autorisation. */
  async function showStateAtLoad(): Promise<void> {
    const rows: [string, string | Node][] = [];
    for (const [key, label, mode] of [
      [CARD_KEY, 'Carte', 'read'],
      [SSD_KEY, 'SSD', 'readwrite'],
    ] as const) {
      try {
        const handle = await loadHandle(key);
        if (!handle) {
          rows.push([label, 'aucune poignée enregistrée']);
          continue;
        }
        const permission = await handle.queryPermission({ mode });
        const check = await checkHandle(handle, mode);
        rows.push([label, h('span', {}, badge(STATE_KIND[check.state], check.state), ` « ${handle.name} », autorisation ${permission}. ${check.message}${check.errorName ? ` (${check.errorName})` : ''}`)]);
        state.journal.add({ step: STEP, test: `état au chargement ${label}`, param: mode, result: check.state === 'ok' ? 'OK' : 'ECHEC', detail: `nom=${handle.name} permission=${permission} état=${check.state}${check.errorName ? ` erreur=${check.errorName}` : ''}` });
      } catch (error) {
        rows.push([label, `lecture impossible (${errorDetail(error)})`]);
        state.journal.add({ step: STEP, test: `état au chargement ${label}`, result: 'ECHEC', detail: errorDetail(error) });
      }
    }
    render(atLoad, h('p', {}, "État à l'ouverture de la page (sans rien demander) :"), keyValueTable(rows));
  }

  async function verify(): Promise<boolean> {
    const param = scenario.read();
    step.setStatus('running');
    result.show('running', 'Vérification...');
    const lines: (string | Node)[] = [];
    let allOk = true;
    // 1. Charger les deux poignées et demander les autorisations tout de suite, tant que
    //    l'appui sur le bouton compte encore comme geste de l'utilisateur.
    const loaded: { key: string; label: string; mode: AccessMode; handle: FileSystemDirectoryHandle | null; before: string; after: string; error?: unknown }[] = [];
    for (const [key, label, mode] of [
      [CARD_KEY, 'Carte', 'read'],
      [SSD_KEY, 'SSD', 'readwrite'],
    ] as const) {
      const item: (typeof loaded)[number] = { key, label, mode, handle: null, before: '', after: '' };
      loaded.push(item);
      try {
        item.handle = await loadHandle(key);
        if (!item.handle) continue;
        item.before = await item.handle.queryPermission({ mode });
        item.after = item.before === 'granted' ? 'granted' : await item.handle.requestPermission({ mode });
      } catch (error) {
        item.error = error;
      }
    }
    // 2. Vérifier chaque poignée : checkHandle, parcours, lecture, écriture pour le SSD.
    for (const item of loaded) {
      const t0 = performance.now();
      if (!item.handle) {
        lines.push(h('p', {}, badge('na'), ` ${item.label} : aucune poignée enregistrée${item.error ? ` (${errorDetail(item.error)})` : ''}. Choisissez le dossier à l'étape ${item.label === 'Carte' ? 1 : 2}.`));
        state.journal.add({ step: STEP, test: `vérification ${item.label}`, param, result: item.error ? 'ECHEC' : 'NON DISPONIBLE', detail: item.error ? errorDetail(item.error) : 'aucune poignée enregistrée' });
        if (item.error) allOk = false;
        continue;
      }
      const handle = item.handle;
      const details: string[] = [`autorisation avant ${item.before || '?'}, après ${item.after || '?'}`];
      let ok = false;
      try {
        if (item.error) throw item.error;
        const check = await checkHandle(handle, item.mode);
        details.push(`checkHandle ${check.state}${check.errorName ? ` (${check.errorName})` : ''}`);
        const current = item.label === 'Carte' ? state.card?.handle : state.ssd?.handle;
        if (current) details.push(`même dossier que la sélection en cours : ${(await handle.isSameEntry(current)) ? 'oui' : 'non'}`);
        if (check.state === 'ok') {
          if (item.label === 'Carte') {
            const source = new ReadOnlySource(handle);
            const top = await source.list('');
            details.push(`${top.length} entrées au premier niveau`);
            const file = await firstFile(source);
            if (file) {
              const bytes = await readHead(source, file, 1024 * 1024);
              details.push(`lecture de ${file} : ${bytes} octets`);
            } else details.push('aucun fichier à lire');
            // La carte relue redevient la carte de travail des étapes 1 à 4.
            if (!state.card || !(await state.card.handle.isSameEntry(handle))) {
              state.card = { handle, source, scan: null };
              state.changed();
            }
          } else {
            const backend = new FsaDirectoryBackend(handle);
            const path = joinPath(TEST_DIR, 'persistance.txt');
            const text = `Vérification ${param} ${new Date().toISOString()}\n`;
            await backend.ensureDirectory(TEST_DIR);
            await backend.writeFile(path, new Blob([text]).stream() as ReadableStream<Uint8Array>, { ifExists: 'replace' });
            const input = await backend.openRead(path);
            const read = await measureRead(input.stream, false);
            details.push(`écriture puis relecture de ${path} : ${read.bytes === new TextEncoder().encode(text).byteLength ? 'correcte' : 'taille différente'}`);
            if (!state.ssd || !(await state.ssd.handle.isSameEntry(handle))) {
              state.ssd = { handle, backend };
              state.changed();
            }
          }
          ok = true;
        }
      } catch (error) {
        details.push(errorDetail(error));
        lines.push(errorBlock(error, item.label));
      }
      const ms = performance.now() - t0;
      if (!ok) allOk = false;
      state.journal.add({ step: STEP, test: `vérification ${item.label}`, param, ms, rate: null, result: ok ? 'OK' : 'ECHEC', detail: `nom=${handle.name} ; ${details.join(' ; ')}` });
      lines.unshift(h('div', {}, h('p', {}, badge(ok ? 'ok' : 'fail'), ` ${item.label} « ${handle.name} » : ${ok ? 'utilisable' : 'inutilisable'} (${formatDuration(ms)})`), h('ul', { class: 'lines' }, ...details.map((d) => h('li', {}, d)))));
    }
    step.setStatus(allOk ? 'ok' : 'fail');
    result.show(allOk ? 'ok' : 'fail', allOk ? 'Poignées utilisables sans rechoisir les dossiers.' : 'Au moins une poignée est inutilisable : noter le résultat, puis rechoisir le dossier.', lines);
    return allOk;
  }

  async function saveNow(): Promise<boolean> {
    const done: string[] = [];
    try {
      if (state.card) {
        await saveHandle(CARD_KEY, state.card.handle);
        done.push(`carte « ${state.card.handle.name} »`);
      }
      if (state.ssd) {
        await saveHandle(SSD_KEY, state.ssd.handle);
        done.push(`SSD « ${state.ssd.handle.name} »`);
      }
      state.journal.add({ step: STEP, test: 'enregistrement manuel', result: done.length > 0 ? 'OK' : 'INFO', detail: done.join(', ') || 'rien à enregistrer' });
      saveResult.show(done.length > 0 ? 'ok' : 'na', done.length > 0 ? `Enregistré : ${done.join(', ')}.` : "Choisissez d'abord la carte et le SSD.");
      return true;
    } catch (error) {
      state.journal.add({ step: STEP, test: 'enregistrement manuel', result: 'ECHEC', detail: errorDetail(error) });
      saveResult.show('fail', 'Enregistrement impossible.', [errorBlock(error)]);
      return false;
    }
  }

  step.body.append(
    atLoad,
    scenario.el,
    instructions,
    actionButton('Vérifier maintenant', () => void runTest({}, verify, (e) => result.show('fail', 'Erreur inattendue', [errorBlock(e)]))),
    result.el,
    actionButton('Enregistrer à nouveau les poignées actuelles', () => void runTest({}, saveNow, (e) => saveResult.show('fail', 'Erreur inattendue', [errorBlock(e)])), 'secondary'),
    saveResult.el,
  );
  void showStateAtLoad();
  return step;
}
