/*
 * Étape 2 : écriture sur le SSD. Le SSD est ouvert en FsaDirectoryBackend
 * (lecture et écriture). Tout est écrit dans ESAM_test_etape0/, seul dossier que
 * la page peut supprimer.
 */
import { errorDetail, errorInfo } from './analysis';
import { runTest, SSD_KEY, state, TEST_DIR } from './context';
import { formatBytes, formatDuration, formatRateOf, GIB, MIB } from './format';
import { CRITICAL_TESTS } from './journal-format';
import { measureRead, measureWritePattern, newSeed, pickDirectory, type ReadMeasure, type WriteMeasure } from './ops';
import { actionButton, choice, createStep, errorBlock, keyValueTable, progressArea, resultArea, type Step } from './ui';
import { saveHandle } from '../platform';
import { FsaDirectoryBackend, joinPath, StorageError } from '../storage';
import { h } from '../ui/dom';

const STEP = 2;
/** Limite de taille d'un fichier en FAT32 (4 Gio moins un octet). */
const FAT32_LIMIT = 4 * GIB - 1;

export function createSsdStep(): Step {
  const step = createStep(
    STEP,
    'Écriture sur le SSD',
    `Branchez le SSD sur le hub. Choisissez un dossier du SSD (la racine convient). La page crée le dossier ${TEST_DIR} et n'écrit nulle part ailleurs.`,
  );
  const pickResult = resultArea();
  const writeResult = resultArea();
  const extraResult = resultArea();
  const cleanResult = resultArea();
  const progress = progressArea();

  const size = choice<number>(
    "Taille du fichier d'essai",
    [
      { value: 16 * MIB, label: '16 Mo (essai rapide)' },
      { value: 256 * MIB, label: '256 Mo' },
      { value: GIB, label: '1 Go (test demandé)' },
      { value: 4 * GIB, label: '4 Go (vérifie exFAT, dépasse la limite FAT32)' },
    ],
    GIB,
  );
  const chunk = choice<number>(
    'Taille des morceaux écrits',
    [
      { value: 4 * MIB, label: '4 Mo' },
      { value: 8 * MIB, label: '8 Mo' },
      { value: 16 * MIB, label: '16 Mo' },
    ],
    8 * MIB,
  );

  async function pick(): Promise<boolean> {
    pickResult.show('running', 'Choix du dossier...');
    try {
      const { handle, startIn } = await pickDirectory('readwrite', 'esam-ssd');
      state.ssd = { handle, backend: new FsaDirectoryBackend(handle) };
      const permission = await handle.queryPermission({ mode: 'readwrite' });
      state.journal.add({ step: STEP, test: 'choix dossier SSD', param: 'mode readwrite', result: permission === 'granted' ? 'OK' : 'ECHEC', detail: `nom=${handle.name} permission=${permission} startIn=${startIn}` });
      try {
        await saveHandle(SSD_KEY, handle);
        state.journal.add({ step: 5, test: 'enregistrement poignée SSD', result: 'OK', detail: handle.name });
      } catch (error) {
        state.journal.add({ step: 5, test: 'enregistrement poignée SSD', result: 'ECHEC', detail: errorDetail(error) });
      }
      state.changed();
      pickResult.show(permission === 'granted' ? 'ok' : 'warn', `SSD choisi : « ${handle.name} ».`, [`Autorisation d'écriture : ${permission === 'granted' ? 'accordée' : permission}.`]);
      step.setStatus('warn', 'Écriture à faire');
      return true;
    } catch (error) {
      const aborted = errorInfo(error).name === 'AbortError';
      pickResult.show(aborted ? 'warn' : 'fail', aborted ? 'Choix annulé.' : 'Impossible de choisir le dossier du SSD.', [errorBlock(error, 'showDirectoryPicker')]);
      state.journal.add({ step: STEP, test: 'choix dossier SSD', param: 'mode readwrite', result: aborted ? 'INFO' : 'ECHEC', detail: errorDetail(error) });
      step.setStatus(aborted ? 'warn' : 'fail', aborted ? 'Annulé' : 'Échec');
      return false;
    }
  }

  async function writeAndVerify(): Promise<boolean> {
    const ssd = state.ssd;
    if (!ssd) {
      writeResult.show('na', "Choisissez d'abord le dossier du SSD.");
      return false;
    }
    const total = size.read();
    const chunkSize = chunk.read();
    const param = `${formatBytes(total)}, morceaux ${formatBytes(chunkSize)}`;
    const path = joinPath(TEST_DIR, `essai_${Math.round(total / MIB)}Mo.bin`);
    step.setStatus('running');
    writeResult.show('running', `Écriture de ${formatBytes(total)} dans ${path}...`);
    let written: WriteMeasure;
    try {
      await ssd.backend.ensureDirectory(TEST_DIR);
      progress.start(`Écriture de ${formatBytes(total)}`, total);
      written = await measureWritePattern(ssd.backend, path, total, chunkSize, newSeed(), true, (done, meter) => progress.update(done, meter));
      progress.finish();
    } catch (error) {
      progress.finish();
      step.setStatus('fail');
      const fat32 = total > FAT32_LIMIT ? ['Si l\'erreur arrive vers 4 Go, le SSD est probablement formaté en FAT32 et non en exFAT.'] : [];
      writeResult.show('fail', "L'écriture sur le SSD a échoué.", [errorBlock(error, 'écriture'), ...fat32]);
      state.journal.add({ step: STEP, test: CRITICAL_TESTS.ssdWrite.test, param, bytes: total, result: 'ECHEC', detail: errorDetail(error) });
      return false;
    }
    const writeMs = written.openMs + written.writeMs + written.closeMs;
    state.journal.add({
      step: STEP,
      test: CRITICAL_TESTS.ssdWrite.test,
      param,
      bytes: written.bytes,
      ms: writeMs,
      result: written.bytes === total ? 'OK' : 'ECHEC',
      detail: `ouverture ${Math.round(written.openMs)} ms, write ${Math.round(written.writeMs)} ms, close ${Math.round(written.closeMs)} ms, génération ${Math.round(written.genMs)} ms, empreinte ${Math.round(written.hashMs)} ms, total mural ${Math.round(written.ms)} ms, sha256 ${written.sha256}`,
    });
    state.journal.add({ step: STEP, test: 'close() après écriture', param, bytes: written.bytes, ms: written.closeMs, rate: null, result: 'INFO', detail: 'validation du fichier temporaire .crswap' });

    writeResult.show('running', 'Relecture et calcul de l\'empreinte...');
    let read: ReadMeasure;
    try {
      const input = await ssd.backend.openRead(path);
      progress.start('Relecture', input.size);
      read = await measureRead(input.stream, true, (done, meter) => progress.update(done, meter));
      progress.finish();
    } catch (error) {
      progress.finish();
      step.setStatus('fail');
      writeResult.show('fail', 'Le fichier est écrit mais ne se relit pas.', [errorBlock(error, 'relecture')]);
      state.journal.add({ step: STEP, test: CRITICAL_TESTS.ssdVerify.test, param, result: 'ECHEC', detail: errorDetail(error) });
      return false;
    }
    const same = read.sha256 === written.sha256 && read.bytes === written.bytes;
    state.journal.add({
      step: STEP,
      test: CRITICAL_TESTS.ssdVerify.test,
      param,
      bytes: read.bytes,
      ms: read.ms,
      result: same ? 'OK' : 'ECHEC',
      detail: `${same ? 'empreintes identiques' : 'EMPREINTES DIFFÉRENTES'} : écrit ${written.sha256}, relu ${read.sha256}; lecture ${Math.round(read.readMs)} ms, empreinte ${Math.round(read.hashMs)} ms`,
    });
    step.setStatus(same ? 'ok' : 'fail');
    writeResult.show(
      same ? 'ok' : 'fail',
      same ? 'Fichier écrit puis relu à l\'identique.' : 'Le fichier relu est différent du fichier écrit.',
      [
        keyValueTable([
          ['Fichier', path],
          ['Taille', formatBytes(written.bytes)],
          ['Écriture seule (jusqu\'au close inclus)', `${formatDuration(writeMs)}, ${formatRateOf(written.bytes, writeMs)}`],
          ['dont close()', formatDuration(written.closeMs)],
          ['Relecture', `${formatDuration(read.ms)}, ${formatRateOf(read.bytes, read.ms)}`],
          ['Empreinte pendant la relecture', formatDuration(read.hashMs)],
          ['Empreinte écrite', written.sha256 ?? '?'],
          ['Empreinte relue', read.sha256 ?? '?'],
        ]),
        written.closeMs > writeMs * 0.2 ? h('p', { class: 'warn-text' }, 'Le close() prend une part importante du temps : Chrome recopie le fichier temporaire au moment de valider.') : '',
      ],
      { ecriture: written, relecture: read },
    );
    return same;
  }

  /** Points à lever (CLAUDE.md) : move() pour renommer un dossier, coût de la reprise. */
  async function extraTests(): Promise<boolean> {
    const ssd = state.ssd;
    if (!ssd) {
      extraResult.show('na', "Choisissez d'abord le dossier du SSD.");
      return false;
    }
    const lines: (string | Node)[] = [];
    extraResult.show('running', 'Tests complémentaires...');
    // 1. Renommage d'un dossier (move).
    try {
      const testDir = await ssd.handle.getDirectoryHandle(TEST_DIR, { create: true });
      await testDir.removeEntry('renommage_b', { recursive: true }).catch(() => undefined);
      await ssd.backend.ensureDirectory(joinPath(TEST_DIR, 'renommage_a'));
      const t0 = performance.now();
      await ssd.backend.renameDirectory(joinPath(TEST_DIR, 'renommage_a'), 'renommage_b');
      const ms = performance.now() - t0;
      const ok = (await ssd.backend.exists(joinPath(TEST_DIR, 'renommage_b'))) && !(await ssd.backend.exists(joinPath(TEST_DIR, 'renommage_a')));
      state.journal.add({ step: STEP, test: 'renommage dossier (move)', ms, rate: null, result: ok ? 'OK' : 'ECHEC', detail: ok ? 'renommage_a devenu renommage_b' : 'résultat inattendu' });
      lines.push(`Renommage d'un dossier : ${ok ? 'possible' : 'résultat inattendu'} (${formatDuration(ms)}).`);
    } catch (error) {
      const unsupported = error instanceof StorageError && error.code === 'unsupported';
      state.journal.add({ step: STEP, test: 'renommage dossier (move)', result: unsupported ? 'NON DISPONIBLE' : 'ECHEC', detail: errorDetail(error) });
      lines.push(unsupported ? "Renommage d'un dossier : non disponible sur ce téléphone." : h('div', {}, "Renommage d'un dossier : échec.", errorBlock(error)));
    }
    // 2. Reprise d'écriture sur un fichier existant (createWritable keepExistingData).
    try {
      const entries = await ssd.backend.list(TEST_DIR);
      const existing = entries.filter((e) => e.kind === 'file' && e.name.startsWith('essai_')).sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
      if (!existing || existing.size === null) {
        lines.push("Reprise d'écriture : faites d'abord le test d'écriture ci-dessus (il faut un fichier existant).");
        state.journal.add({ step: STEP, test: 'reprise keepExistingData', result: 'INFO', detail: 'pas de fichier d\'essai' });
      } else {
        const path = joinPath(TEST_DIR, existing.name);
        const t0 = performance.now();
        const writer = await ssd.backend.openWriter(path, { resumeAt: existing.size });
        const openMs = performance.now() - t0;
        const extra = new Uint8Array(MIB);
        crypto.getRandomValues(extra.subarray(0, 65536));
        await writer.write(extra);
        const t1 = performance.now();
        await writer.close();
        const closeMs = performance.now() - t1;
        const after = await ssd.backend.stat(path);
        const ok = after?.size === existing.size + MIB;
        state.journal.add({
          step: STEP,
          test: 'reprise keepExistingData',
          param: existing.name,
          bytes: existing.size,
          ms: openMs + closeMs,
          result: ok ? 'OK' : 'ECHEC',
          detail: `ouverture ${Math.round(openMs)} ms, close ${Math.round(closeMs)} ms pour ajouter 1 Mo à ${existing.size} octets, taille finale ${after?.size ?? '?'}`,
        });
        lines.push(`Reprise sur un fichier de ${formatBytes(existing.size)} : ouverture ${formatDuration(openMs)}, close ${formatDuration(closeMs)} pour ajouter 1 Mo. ${ok ? 'Taille finale correcte.' : 'Taille finale incorrecte.'}`);
      }
    } catch (error) {
      state.journal.add({ step: STEP, test: 'reprise keepExistingData', result: 'ECHEC', detail: errorDetail(error) });
      lines.push(h('div', {}, "Reprise d'écriture : échec.", errorBlock(error)));
    }
    extraResult.show('ok', 'Tests complémentaires terminés.', lines);
    return true;
  }

  async function cleanup(): Promise<boolean> {
    const ssd = state.ssd;
    if (!ssd) {
      cleanResult.show('na', "Choisissez d'abord le dossier du SSD.");
      return false;
    }
    if (!window.confirm(`Supprimer le dossier ${TEST_DIR} et tout son contenu sur le SSD « ${ssd.handle.name} » ?`)) return false;
    try {
      const t0 = performance.now();
      await ssd.handle.removeEntry(TEST_DIR, { recursive: true });
      state.journal.add({ step: STEP, test: 'nettoyage dossier de test', ms: performance.now() - t0, rate: null, result: 'OK', detail: TEST_DIR });
      cleanResult.show('ok', `Dossier ${TEST_DIR} supprimé.`);
      return true;
    } catch (error) {
      if (errorInfo(error).name === 'NotFoundError') {
        cleanResult.show('ok', `Le dossier ${TEST_DIR} n'existe pas : rien à supprimer.`);
        return true;
      }
      state.journal.add({ step: STEP, test: 'nettoyage dossier de test', result: 'ECHEC', detail: errorDetail(error) });
      cleanResult.show('fail', 'Suppression impossible.', [errorBlock(error)]);
      return false;
    }
  }

  const fail = (area: ReturnType<typeof resultArea>) => (e: unknown) => area.show('fail', 'Erreur inattendue', [errorBlock(e)]);
  step.body.append(
    actionButton('Choisir le dossier du SSD', () => void runTest({}, pick, fail(pickResult))),
    pickResult.el,
    size.el,
    chunk.el,
    actionButton("Écrire puis relire le fichier d'essai", () => void runTest({ long: true, title: 'Test du SSD terminé' }, writeAndVerify, fail(writeResult))),
    progress.el,
    writeResult.el,
    h('h3', {}, 'Tests complémentaires'),
    h('p', { class: 'muted' }, "Renommer un dossier (utile pour corriger un nom d'intervention) et reprendre l'écriture d'un gros fichier (coût de la reprise après coupure)."),
    actionButton('Tester renommage et reprise', () => void runTest({ long: true, title: 'Tests complémentaires terminés' }, extraTests, fail(extraResult)), 'secondary'),
    extraResult.el,
    h('h3', {}, 'Nettoyage'),
    h('p', { class: 'muted' }, `Supprime uniquement le dossier ${TEST_DIR} du SSD. À faire à la fin des tests.`),
    actionButton(`Supprimer ${TEST_DIR}`, () => void runTest({}, cleanup, fail(cleanResult)), 'danger'),
    cleanResult.el,
  );
  return step;
}

