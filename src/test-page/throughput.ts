/*
 * Étape 3 : débits. (a) lecture seule de la carte, (b) écriture seule sur le SSD,
 * (c) copie carte vers SSD sans empreinte, (d) copie avec SHA-256 en flux puis
 * relecture de la copie et comparaison. La carte est lue en ReadOnlySource :
 * elle n'est jamais modifiée. Les copies vont dans ESAM_test_etape0/ sur le SSD.
 */
import { errorDetail, largestFile, type ScannedFile } from './analysis';
import { runTest, state, TEST_DIR } from './context';
import { describeFailure, failureDetail, isMeasureError } from './failure';
import { formatBytes, formatDuration, formatRateOf, MIB } from './format';
import { measureCopy, measureRead, measureWritePattern, newSeed } from './ops';
import { actionButton, choice, createStep, errorBlock, progressArea, resultArea, type Step } from './ui';
import { joinPath } from '../storage';
import { h, render } from '../ui/dom';

const STEP = 3;

type Phase = 'a' | 'b' | 'c' | 'd';

const PHASE_TITLES: Record<Phase, string> = {
  a: 'a. Lecture seule (carte)',
  b: 'b. Écriture seule (SSD)',
  c: 'c. Copie sans empreinte',
  d: 'd. Copie avec empreinte puis vérification',
};

interface Row {
  phase: string;
  bytes: number;
  ms: number;
  ok: boolean;
  note: string;
}

/** Nom de fichier sans caractère gênant, pour les copies dans le dossier de test. */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

export function createThroughputStep(): Step {
  const step = createStep(
    STEP,
    'Débits',
    "Mesure chaque maillon séparément avec le plus gros fichier de la carte. Il faut avoir fait les étapes 1 (carte choisie et parcourue) et 2 (SSD choisi).",
  );
  const prereq = h('div', { class: 'prereq' });
  const chunk = choice<number>(
    'Taille des morceaux',
    [
      { value: 1 * MIB, label: '1 Mo' },
      { value: 4 * MIB, label: '4 Mo' },
      { value: 16 * MIB, label: '16 Mo' },
      { value: 64 * MIB, label: '64 Mo' },
    ],
    4 * MIB,
  );
  const mode = choice<'parallel' | 'sequential'>(
    'Enchaînement lecture et écriture',
    [
      { value: 'parallel', label: 'En parallèle (lecture du morceau suivant pendant l\'écriture)' },
      { value: 'sequential', label: 'L\'un après l\'autre' },
    ],
    'parallel',
  );
  const progress = progressArea();
  const result = resultArea();
  const table = h('div', { class: 'table-wrap' });
  let rows: Row[] = [];

  const paintPrereq = () => {
    const biggest = state.card?.scan ? largestFile(state.card.scan.files) : null;
    render(
      prereq,
      h('p', {}, `Carte : ${state.card ? `« ${state.card.handle.name} »` : 'pas encore choisie (étape 1)'}${biggest ? `, plus gros fichier ${biggest.name} (${formatBytes(biggest.size)})` : ''}.`),
      h('p', {}, `SSD : ${state.ssd ? `« ${state.ssd.handle.name} »` : 'pas encore choisi (étape 2)'}.`),
    );
  };
  state.onChange(paintPrereq);
  paintPrereq();

  const paintTable = () => {
    render(
      table,
      rows.length === 0
        ? ''
        : h(
            'table',
            { class: 'rates' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Mesure'), h('th', {}, 'Débit'), h('th', {}, 'Durée'))),
            h(
              'tbody',
              {},
              ...rows.map((r) => h('tr', { class: r.ok ? '' : 'row-fail' }, h('td', {}, r.phase, h('small', { class: 'muted' }, r.note)), h('td', {}, r.ok ? formatRateOf(r.bytes, r.ms) : 'échec'), h('td', {}, formatDuration(r.ms)))),
            ),
          ),
    );
  };

  function need(): { file: ScannedFile; ok: true } | { ok: false } {
    const biggest = state.card?.scan ? largestFile(state.card.scan.files) : null;
    if (!state.card || !biggest || !state.ssd) {
      result.show('na', 'Il faut la carte (étape 1) et le SSD (étape 2).');
      return { ok: false };
    }
    return { file: biggest, ok: true };
  }

  async function runPhase(phase: Phase, file: ScannedFile): Promise<boolean> {
    const card = state.card;
    const ssd = state.ssd;
    if (!card || !ssd) return false;
    const chunkSize = chunk.read();
    const parallel = mode.read() === 'parallel';
    const param = `morceau ${formatBytes(chunkSize)}${phase === 'c' || phase === 'd' ? `, ${parallel ? 'parallèle' : 'séquentiel'}` : ''}`;
    const title = PHASE_TITLES[phase];
    result.show('running', `${title}...`);
    try {
      await ssd.backend.ensureDirectory(TEST_DIR);
      if (phase === 'a') {
        const input = await card.source.openRead(file.path);
        progress.start(title, input.size);
        const m = await measureRead(input.stream, false, (d, meter) => progress.update(d, meter));
        const ok = m.bytes === input.size;
        state.journal.add({ step: STEP, test: 'a lecture seule', param: `${file.name}, flux natif`, bytes: m.bytes, ms: m.ms, result: ok ? 'OK' : 'ECHEC', detail: `morceaux natifs ${m.native.count}, moyenne ${Math.round(m.native.mean)} octets` });
        rows.push({ phase: title, bytes: m.bytes, ms: m.ms, ok, note: ` (morceaux du navigateur, ${formatBytes(m.native.mean)} en moyenne)` });
      } else if (phase === 'b') {
        const path = joinPath(TEST_DIR, 'debit_ecriture.bin');
        progress.start(title, file.size);
        const m = await measureWritePattern(ssd.backend, path, file.size, chunkSize, newSeed(), false, (d, meter) => progress.update(d, meter));
        const writeMs = m.openMs + m.writeMs + m.closeMs;
        const ok = m.bytes === file.size;
        state.journal.add({ step: STEP, test: 'b écriture seule', param, bytes: m.bytes, ms: writeMs, result: ok ? 'OK' : 'ECHEC', detail: `close ${Math.round(m.closeMs)} ms, génération ${Math.round(m.genMs)} ms (non comptée), total mural ${Math.round(m.ms)} ms` });
        rows.push({ phase: title, bytes: m.bytes, ms: writeMs, ok, note: ` (${param}, dont close ${formatDuration(m.closeMs)})` });
      } else {
        const hash = phase === 'd';
        const dest = joinPath(TEST_DIR, `${hash ? 'copie_avec_empreinte_' : 'copie_sans_empreinte_'}${safeName(file.name)}`);
        progress.start(title, file.size);
        const m = await measureCopy(card.source, file.path, ssd.backend, dest, chunkSize, { hash, parallel }, (d, meter) => progress.update(d, meter));
        const ok = m.bytes === file.size;
        state.journal.add({
          step: STEP,
          test: hash ? 'd copie avec empreinte' : 'c copie sans empreinte',
          param,
          bytes: m.bytes,
          ms: m.ms,
          result: ok ? 'OK' : 'ECHEC',
          detail: `lecture ${Math.round(m.readMs)} ms, empreinte ${Math.round(m.hashMs)} ms, attente écriture ${Math.round(m.writeMs)} ms, close ${Math.round(m.closeMs)} ms, ouverture ${Math.round(m.openMs)} ms${m.sha256 ? `, sha256 ${m.sha256}` : ''}`,
        });
        rows.push({ phase: hash ? 'd. Copie avec empreinte' : title, bytes: m.bytes, ms: m.ms, ok, note: ` (${param}, close ${formatDuration(m.closeMs)})` });
        if (hash) {
          progress.start('Relecture de la copie', m.bytes);
          const input = await ssd.backend.openRead(dest);
          const r = await measureRead(input.stream, true, (d, meter) => progress.update(d, meter));
          const same = r.sha256 === m.sha256 && r.bytes === m.bytes;
          state.journal.add({
            step: STEP,
            test: 'd relecture et comparaison',
            param,
            bytes: r.bytes,
            ms: r.ms,
            result: same ? 'OK' : 'ECHEC',
            detail: `${same ? 'empreintes identiques' : 'EMPREINTES DIFFÉRENTES'} : copie ${m.sha256}, relue ${r.sha256}`,
          });
          rows.push({ phase: 'd. Relecture et comparaison', bytes: r.bytes, ms: r.ms, ok: same, note: same ? ' (empreintes identiques)' : ' (EMPREINTES DIFFÉRENTES)' });
          rows.push({ phase: 'd. Total copie vérifiée', bytes: m.bytes, ms: m.ms + r.ms, ok: same, note: ' (copie puis relecture)' });
        }
      }
      progress.finish();
      paintTable();
      return true;
    } catch (error) {
      progress.finish();
      const failure = isMeasureError(error) ? error.failure : null;
      state.journal.add({ step: STEP, test: `${phase} échec`, param, bytes: failure?.bytesWritten ?? null, ms: failure?.elapsedMs ?? null, rate: null, result: 'ECHEC', detail: failure ? failureDetail(failure) : errorDetail(error) });
      rows.push({ phase: title, bytes: 0, ms: 0, ok: false, note: ` (${failure ? `${describeFailure(failure)}, ` : ''}${errorDetail(error)})` });
      paintTable();
      result.show('fail', `${title} : échec.`, [failure ? h('p', { class: 'fail-text' }, `${describeFailure(failure)}.`) : '', errorBlock(error)]);
      return false;
    }
  }

  async function run(phases: Phase[]): Promise<boolean> {
    const n = need();
    if (!n.ok) return false;
    step.setStatus('running');
    let all = true;
    for (const phase of phases) {
      if (!(await runPhase(phase, n.file))) {
        all = false;
        break;
      }
    }
    step.setStatus(all ? 'ok' : 'fail');
    if (all) result.show('ok', 'Mesures terminées.', [`Fichier : ${n.file.path}, ${formatBytes(n.file.size)}.`], rows);
    return all;
  }

  const go = (phases: Phase[], primary = false) =>
    actionButton(
      phases.length > 1 ? 'Lancer les 4 mesures' : PHASE_TITLES[phases[0] ?? 'a'],
      () => void runTest({ long: true, title: 'Mesure des débits terminée' }, () => run(phases), (e) => result.show('fail', 'Erreur inattendue', [errorBlock(e)])),
      primary ? 'primary' : 'secondary',
    );

  step.body.append(
    h('p', { class: 'reminder' }, "La carte n'est jamais modifiée : elle est ouverte en lecture seule. Les fichiers écrits vont uniquement dans ESAM_test_etape0 sur le SSD."),
    prereq,
    chunk.el,
    mode.el,
    go(['a', 'b', 'c', 'd'], true),
    h('div', { class: 'btn-grid' }, go(['a']), go(['b']), go(['c']), go(['d'])),
    actionButton('Effacer le tableau', () => {
      rows = [];
      paintTable();
      result.clear();
    }, 'secondary'),
    progress.el,
    result.el,
    table,
  );
  return step;
}
