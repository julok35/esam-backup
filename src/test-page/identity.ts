/*
 * Étape 4 : ce que l'API expose pour identifier la carte (et le SSD), sans rien
 * écrire sur la carte. Si aucun identifiant de volume n'existe, l'empreinte de
 * carte (fichiers les plus anciens) servira à la reconnaître.
 */
import { cardFingerprintText, classifyHandleName, describeHandleName, errorDetail, oldestFiles } from './analysis';
import { scanCard } from './card-tests';
import { CARD_KEY, runTest, SSD_KEY, state } from './context';
import { formatBytes } from './format';
import { pickDirectory } from './ops';
import { actionButton, createStep, errorBlock, keyValueTable, resultArea, type Step } from './ui';
import { loadHandle, StreamingSha256 } from '../platform';
import { h } from '../ui/dom';

const STEP = 4;

interface HandleReport {
  name: string;
  kind: string;
  nameKind: string;
  uniqueId: string;
  enumerable: Record<string, string>;
  prototypeMembers: string[];
  sameAsStored: string;
}

type WithUniqueId = FileSystemHandle & { getUniqueId?: () => Promise<string> };

/** Toutes les propriétés visibles d'une poignée : énumérables et membres du prototype. */
function inspect(handle: FileSystemHandle): { enumerable: Record<string, string>; prototypeMembers: string[] } {
  const enumerable: Record<string, string> = {};
  for (const key in handle) {
    try {
      const value = (handle as unknown as Record<string, unknown>)[key];
      enumerable[key] = typeof value === 'function' ? 'fonction' : String(value);
    } catch (error) {
      enumerable[key] = `illisible (${errorDetail(error)})`;
    }
  }
  const members = new Set<string>();
  let proto: object | null = Object.getPrototypeOf(handle) as object | null;
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) if (name !== 'constructor') members.add(name);
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return { enumerable, prototypeMembers: [...members].sort() };
}

async function uniqueIdOf(handle: FileSystemHandle): Promise<string> {
  const fn = (handle as WithUniqueId).getUniqueId;
  if (typeof fn !== 'function') return 'absent';
  try {
    return await fn.call(handle);
  } catch (error) {
    return `erreur ${errorDetail(error)}`;
  }
}

async function compare(a: FileSystemHandle, b: FileSystemHandle | null): Promise<string> {
  if (!b) return 'aucune poignée conservée';
  try {
    return (await a.isSameEntry(b)) ? 'oui (même dossier)' : 'non (dossier différent)';
  } catch (error) {
    return `erreur ${errorDetail(error)}`;
  }
}

async function report(handle: FileSystemDirectoryHandle, key: string): Promise<HandleReport> {
  let stored: FileSystemDirectoryHandle | null = null;
  try {
    stored = await loadHandle(key);
  } catch {
    stored = null;
  }
  const { enumerable, prototypeMembers } = inspect(handle);
  return {
    name: handle.name,
    kind: handle.kind,
    nameKind: classifyHandleName(handle.name),
    uniqueId: await uniqueIdOf(handle),
    enumerable,
    prototypeMembers,
    sameAsStored: await compare(handle, stored),
  };
}

function reportTable(r: HandleReport): HTMLTableElement {
  return keyValueTable([
    ['Nom (name)', r.name],
    ['Type (kind)', r.kind],
    ['Nature du nom', describeHandleName(r.name)],
    ['getUniqueId()', r.uniqueId],
    ['Même dossier que la poignée conservée (isSameEntry)', r.sameAsStored],
    ['Propriétés énumérables', Object.entries(r.enumerable).map(([k, v]) => `${k}=${v}`).join(', ') || 'aucune'],
  ]);
}

async function shortHash(text: string): Promise<string> {
  const hash = await StreamingSha256.create();
  hash.update(new TextEncoder().encode(text));
  return hash.digest().slice(0, 16);
}

export function createIdentityStep(): Step {
  const step = createStep(
    STEP,
    'Identification de la carte',
    "Montre tout ce que Chrome dit de la carte et du SSD : nom, identifiant éventuel, et la liste des 10 fichiers les plus anciens qui servira d'empreinte si aucun identifiant n'existe.",
  );
  const result = resultArea();
  const compareResult = resultArea();

  async function analyse(): Promise<boolean> {
    const card = state.card;
    if (!card) {
      result.show('na', "Choisissez d'abord la carte (étape 1).");
      return false;
    }
    step.setStatus('running');
    result.show('running', 'Analyse...');
    const scan = card.scan ?? (await scanCard((text) => result.show('running', text)));
    const cardReport = await report(card.handle, CARD_KEY);
    const ssdReport = state.ssd ? await report(state.ssd.handle, SSD_KEY) : null;
    const oldest = scan ? oldestFiles(scan.files, 10) : [];
    const fingerprint = scan ? cardFingerprintText(card.handle.name, scan.files) : '';
    const fingerprintId = fingerprint ? await shortHash(fingerprint) : '';

    state.journal.add({ step: STEP, test: 'nom poignée carte', param: cardReport.nameKind, result: 'INFO', detail: `name=${cardReport.name} kind=${cardReport.kind}` });
    state.journal.add({ step: STEP, test: 'getUniqueId carte', result: cardReport.uniqueId === 'absent' ? 'NON DISPONIBLE' : cardReport.uniqueId.startsWith('erreur') ? 'ECHEC' : 'OK', detail: cardReport.uniqueId });
    state.journal.add({ step: STEP, test: 'isSameEntry carte conservée', result: 'INFO', detail: cardReport.sameAsStored });
    state.journal.add({ step: STEP, test: 'propriétés poignée carte', result: 'INFO', detail: `énumérables: ${Object.keys(cardReport.enumerable).join(',')}; prototype: ${cardReport.prototypeMembers.join(',')}` });
    if (ssdReport) {
      state.journal.add({ step: STEP, test: 'nom poignée SSD', param: ssdReport.nameKind, result: 'INFO', detail: `name=${ssdReport.name} getUniqueId=${ssdReport.uniqueId} isSameEntry=${ssdReport.sameAsStored}` });
    }
    if (scan) {
      state.journal.add({
        step: STEP,
        test: 'empreinte de carte',
        param: `${oldest.length} fichiers les plus anciens`,
        result: oldest.length > 0 ? 'OK' : 'ECHEC',
        detail: `id ${fingerprintId} ; ${oldest.map((f) => `${f.name}|${f.size}|${new Date(f.lastModified).toISOString()}`).join(' ; ')}`,
      });
    }

    const nameKind = cardReport.nameKind;
    const identified = cardReport.uniqueId !== 'absent' && !cardReport.uniqueId.startsWith('erreur');
    step.setStatus(identified || nameKind === 'volume-uuid' || nameKind === 'volume-label' ? 'ok' : 'warn', identified ? 'Identifiant' : 'Empreinte');
    result.show(
      'ok',
      identified ? 'Chrome fournit un identifiant de poignée (à vérifier : stable après rebranchement ?).' : "Pas d'identifiant de volume : la carte sera reconnue par son empreinte.",
      [
        h('h3', {}, 'Carte'),
        reportTable(cardReport),
        h('h3', {}, 'Les 10 fichiers les plus anciens (empreinte de carte)'),
        oldest.length === 0
          ? h('p', {}, 'Aucun fichier.')
          : h('ol', { class: 'lines' }, ...oldest.map((f) => h('li', {}, `${f.name}, ${formatBytes(f.size)}, ${new Date(f.lastModified).toLocaleString('fr-FR')}`))),
        fingerprintId ? h('p', { class: 'mono' }, `Identifiant d'empreinte : ${fingerprintId}`) : '',
        h('h3', {}, 'SSD'),
        ssdReport ? reportTable(ssdReport) : h('p', { class: 'muted' }, 'SSD pas encore choisi (étape 2).'),
      ],
      { carte: cardReport, ssd: ssdReport, empreinte: fingerprint },
    );
    return true;
  }

  async function pickAgain(): Promise<boolean> {
    const card = state.card;
    if (!card) {
      compareResult.show('na', "Choisissez d'abord la carte (étape 1).");
      return false;
    }
    try {
      const { handle } = await pickDirectory('read', 'esam-carte');
      const same = await compare(handle, card.handle);
      const idFresh = await uniqueIdOf(handle);
      const idKept = await uniqueIdOf(card.handle);
      state.journal.add({ step: STEP, test: 'isSameEntry nouvelle poignée', param: handle.name, result: 'INFO', detail: `${same} ; getUniqueId nouvelle=${idFresh} conservée=${idKept}` });
      compareResult.show('ok', `Nouvelle poignée comparée à celle de l'étape 1 : ${same}.`, [
        keyValueTable([
          ['Nom de la nouvelle poignée', handle.name],
          ['getUniqueId nouvelle', idFresh],
          ['getUniqueId conservée', idKept],
          ['Identifiants égaux', idFresh === idKept ? 'oui' : 'non'],
        ]),
      ]);
      return true;
    } catch (error) {
      compareResult.show('fail', 'Comparaison impossible.', [errorBlock(error)]);
      state.journal.add({ step: STEP, test: 'isSameEntry nouvelle poignée', result: 'ECHEC', detail: errorDetail(error) });
      return false;
    }
  }

  step.body.append(
    actionButton('Analyser les poignées', () => void runTest({}, analyse, (e) => result.show('fail', 'Erreur inattendue', [errorBlock(e)]))),
    result.el,
    h('h3', {}, 'Comparer avec une nouvelle sélection'),
    h('p', { class: 'muted' }, "Rechoisissez le même dossier de la carte (après l'avoir retirée puis remise, par exemple) : la page indique si Chrome le reconnaît comme le même. Avec une autre carte, la réponse attendue est « non »."),
    actionButton('Rechoisir la carte pour comparer', () => void runTest({}, pickAgain, (e) => compareResult.show('fail', 'Erreur inattendue', [errorBlock(e)])), 'secondary'),
    compareResult.el,
  );
  return step;
}
