/*
 * Étape 2 : écriture sur le SSD. Le SSD est ouvert en FsaDirectoryBackend
 * (lecture et écriture). Tout est écrit dans ESAM_test_etape0/, seul dossier que
 * la page peut supprimer.
 */
import { errorDetail, errorInfo } from './analysis';
import { runTest, SSD_KEY, state, TEST_DIR } from './context';
import { describeFailure, failureDetail, isMeasureError, makeFailure, phaseTimesText, type WriteFailure } from './failure';
import { formatBytes, formatDuration, formatRateOf, GIB, MIB } from './format';
import { CRITICAL_TESTS } from './journal-format';
import {
  attemptTotalMs,
  closeShare,
  closeTrend,
  describeCloseTrend,
  describeLadder,
  formatShare,
  ladderFileName,
  ladderFilesToDelete,
  nextLadderAction,
  RESUME_PROBE_MIN,
  resumeOpenVerdict,
  summarizeLadder,
  VARIANT_SIZE,
  type LadderAttempt,
} from './ladder';
import {
  measureOpenVariant,
  measureRead,
  measureResumeOpen,
  measureWritePattern,
  newSeed,
  OPEN_VARIANTS,
  pickDirectory,
  type ReadMeasure,
  type VariantResult,
  type WriteMeasure,
} from './ops';
import { actionButton, badge, choice, createStep, errorBlock, keyValueTable, progressArea, resultArea, type Step } from './ui';
import { saveHandle } from '../platform';
import { FsaDirectoryBackend, joinPath, StorageError } from '../storage';
import { h } from '../ui/dom';

const STEP = 2;
/** Limite de taille d'un fichier en FAT32 (4 Gio moins un octet). */
const FAT32_LIMIT = 4 * GIB - 1;

/** Échec d'une mesure : description de failure.ts, ou à défaut construite ici. */
function failureOf(error: unknown, fallback: { phase: WriteFailure['phase']; target: number; elapsedMs: number; bytesWritten?: number }): WriteFailure {
  return isMeasureError(error) ? error.failure : makeFailure(error, { bytesWritten: 0, ...fallback });
}

/** Lignes d'écran pour un échec : phrase en clair, temps par phase, exception. */
function failureLines(failure: WriteFailure, error: unknown, context: string): (string | Node)[] {
  return [
    h('p', { class: 'fail-text' }, `${describeFailure(failure)}.`),
    keyValueTable([
      ['Phase en échec', failure.phase],
      ['Octets acceptés par write()', `${failure.bytesWritten} (${formatBytes(failure.bytesWritten)}) sur ${formatBytes(failure.target)} visés`],
      ['Morceau en cours', failure.pendingBytes > 0 ? formatBytes(failure.pendingBytes) : 'aucun'],
      ['Temps par phase', phaseTimesText(failure.phaseMs)],
      ['Exception', `${failure.errorName} : ${failure.errorMessage}`],
    ]),
    errorBlock(error, context),
  ];
}

/** Détail de journal d'une écriture réussie (relu par verdict.ts : cible=, close N ms). */
function writeDetail(m: WriteMeasure, target: number, extra = ''): string {
  const total = m.openMs + m.writeMs + m.closeMs;
  return `cible=${target}, ouverture ${Math.round(m.openMs)} ms, write ${Math.round(m.writeMs)} ms, close ${Math.round(m.closeMs)} ms, part du close ${formatShare(closeShare(m.closeMs, total))}, génération ${Math.round(m.genMs)} ms, total mural ${Math.round(m.ms)} ms${extra}`;
}

/** Tableau des paliers : résultat, débit, part du close(). */
function ladderTable(attempts: readonly LadderAttempt[]): HTMLElement | string {
  if (attempts.length === 0) return '';
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'rates ladder' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Palier'), h('th', {}, 'Résultat'), h('th', {}, 'Débit'))),
      h(
        'tbody',
        {},
        ...attempts.map((a) => {
          const total = attemptTotalMs(a);
          const times = `ouverture ${formatDuration(a.openMs)}, write ${formatDuration(a.writeMs)}, close ${formatDuration(a.closeMs)}`;
          const label = h('td', {}, formatBytes(a.size), a.attempt > 1 ? h('small', { class: 'muted' }, 'second essai') : '');
          if (a.ok) {
            return h('tr', {}, label, h('td', {}, badge('ok'), h('small', { class: 'muted' }, times)), h('td', {}, formatRateOf(a.bytes, total), h('small', { class: 'muted' }, `close ${formatShare(closeShare(a.closeMs, total))}`)));
          }
          const f = a.failure;
          return h(
            'tr',
            { class: 'row-fail' },
            label,
            h('td', {}, badge('fail'), h('small', {}, f ? `phase ${f.phase}, après ${formatBytes(f.bytesWritten)} en ${formatDuration(f.elapsedMs)}, ${f.errorName}` : 'échec')),
            h('td', {}, '-'),
          );
        }),
      ),
    ),
  );
}

/** Tableau des variantes d'ouverture au palier de 16 Mo. */
function variantTable(variants: readonly VariantResult[]): HTMLElement | string {
  if (variants.length === 0) return '';
  return h(
    'div',
    {},
    h('p', {}, "Variantes d'ouverture au palier de 16 Mo :"),
    h(
      'ul',
      { class: 'lines' },
      ...variants.map((r) => {
        const label = OPEN_VARIANTS.find((v) => v.value === r.variant)?.label ?? r.variant;
        let text: string;
        if (r.measure) {
          const total = attemptTotalMs(r.measure);
          text = `OK, ${formatRateOf(r.measure.bytes, total)}, ouverture ${formatDuration(r.measure.openMs)}, close ${formatDuration(r.measure.closeMs)} (${formatShare(closeShare(r.measure.closeMs, total))})`;
        } else if (r.failure) text = `échec : ${describeFailure(r.failure)} (${r.failure.errorName})`;
        else text = 'non disponible sur ce téléphone';
        return h('li', {}, `${label} : ${text}${r.notes.length > 0 ? `. ${r.notes.join(', ')}` : ''}.`);
      }),
    ),
  );
}

export function createSsdStep(): Step {
  const step = createStep(
    STEP,
    'Écriture sur le SSD',
    `Branchez le SSD sur le hub. Choisissez un dossier du SSD (la racine convient). La page crée le dossier ${TEST_DIR} et n'écrit nulle part ailleurs.`,
  );
  const pickResult = resultArea();
  const writeResult = resultArea();
  const extraResult = resultArea();
  const ladderResult = resultArea();
  const ladderProgress = progressArea();
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
    const started = performance.now();
    try {
      await ssd.backend.ensureDirectory(TEST_DIR);
      progress.start(`Écriture de ${formatBytes(total)}`, total);
      written = await measureWritePattern(ssd.backend, path, total, chunkSize, newSeed(), true, (done, meter) => progress.update(done, meter));
      progress.finish();
    } catch (error) {
      progress.finish();
      step.setStatus('fail');
      const failure = failureOf(error, { phase: 'ouverture', target: total, elapsedMs: performance.now() - started });
      const fat32 = total > FAT32_LIMIT ? ['Si l\'erreur arrive vers 4 Go, le SSD est probablement formaté en FAT32 et non en exFAT.'] : [];
      writeResult.show('fail', "L'écriture sur le SSD a échoué.", [...failureLines(failure, error, 'écriture'), ...fat32, 'Pour savoir à partir de quelle taille l\'écriture échoue, faites « Chercher la taille limite » ci-dessous.']);
      state.journal.add({ step: STEP, test: CRITICAL_TESTS.ssdWrite.test, param, bytes: failure.bytesWritten, ms: failure.elapsedMs, rate: null, result: 'ECHEC', detail: failureDetail(failure) });
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
      detail: writeDetail(written, total, `, empreinte ${Math.round(written.hashMs)} ms, sha256 ${written.sha256}`),
    });
    state.journal.add({ step: STEP, test: 'close() après écriture', param, bytes: written.bytes, ms: written.closeMs, rate: null, result: 'INFO', detail: "validation du fichier d'échange (recopie vers le SSD sur Android)" });

    writeResult.show('running', 'Relecture et calcul de l\'empreinte...');
    let read: ReadMeasure;
    const readStarted = performance.now();
    try {
      const input = await ssd.backend.openRead(path);
      progress.start('Relecture', input.size);
      read = await measureRead(input.stream, true, (done, meter) => progress.update(done, meter));
      progress.finish();
    } catch (error) {
      progress.finish();
      step.setStatus('fail');
      const failure = makeFailure(error, { phase: 'relecture', bytesWritten: written.bytes, target: total, elapsedMs: performance.now() - readStarted });
      writeResult.show('fail', 'Le fichier est écrit mais ne se relit pas.', failureLines(failure, error, 'relecture'));
      state.journal.add({ step: STEP, test: CRITICAL_TESTS.ssdVerify.test, param, bytes: written.bytes, result: 'ECHEC', detail: failureDetail(failure) });
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
        written.closeMs > writeMs * 0.2 ? h('p', { class: 'warn-text' }, "Le close() prend une part importante du temps : Chrome recopie le fichier d'échange vers le SSD au moment de valider.") : '',
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
    let smallOpenMs: number | null = null;
    try {
      const entries = await ssd.backend.list(TEST_DIR);
      const existing = entries.filter((e) => e.kind === 'file' && e.name.startsWith('essai_')).sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
      if (!existing || existing.size === null) {
        lines.push("Reprise d'écriture : faites d'abord le test d'écriture ci-dessus (il faut un fichier existant).");
        state.journal.add({ step: STEP, test: CRITICAL_TESTS.ssdResume.test, result: 'INFO', detail: 'pas de fichier d\'essai' });
      } else {
        const path = joinPath(TEST_DIR, existing.name);
        const t0 = performance.now();
        const writer = await ssd.backend.openWriter(path, { resumeAt: existing.size });
        const openMs = performance.now() - t0;
        if (existing.size < 16 * MIB) smallOpenMs = openMs;
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
          test: CRITICAL_TESTS.ssdResume.test,
          param: existing.name,
          bytes: MIB,
          ms: openMs + closeMs,
          result: ok ? 'OK' : 'ECHEC',
          detail: `cible=${MIB}, ouverture ${Math.round(openMs)} ms, close ${Math.round(closeMs)} ms pour ajouter 1 Mo à ${existing.size} octets, taille finale ${after?.size ?? '?'}`,
        });
        lines.push(`Reprise sur un fichier de ${formatBytes(existing.size)} : ouverture ${formatDuration(openMs)}, close ${formatDuration(closeMs)} pour ajouter 1 Mo. ${ok ? 'Taille finale correcte.' : 'Taille finale incorrecte.'}`);
      }
    } catch (error) {
      const failure = failureOf(error, { phase: 'ouverture', target: MIB, elapsedMs: 0 });
      state.journal.add({ step: STEP, test: CRITICAL_TESTS.ssdResume.test, bytes: 0, result: 'ECHEC', detail: `cible=${MIB}, ${errorDetail(error)}` });
      lines.push(h('div', {}, "Reprise d'écriture : échec.", ...failureLines(failure, error, 'reprise')));
    }
    // 3. Coût d'une reprise sur un gros fichier : ouverture keepExistingData seule.
    try {
      const entries = await ssd.backend.list(TEST_DIR);
      const big = entries
        .filter((e) => e.kind === 'file' && (e.name.startsWith('essai_') || e.name.startsWith('palier_')) && (e.size ?? 0) >= RESUME_PROBE_MIN)
        .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
      if (!big) {
        lines.push('Reprise sur gros fichier : aucun fichier de 256 Mo ou plus dans le dossier de test (écrivez un fichier d\'essai de 256 Mo ou plus).');
        state.journal.add({ step: STEP, test: CRITICAL_TESTS.ssdResumeBig.test, result: 'INFO', detail: 'aucun fichier de 256 Mo ou plus' });
      } else {
        lines.push(await probeResume(big.name, smallOpenMs));
      }
    } catch (error) {
      state.journal.add({ step: STEP, test: CRITICAL_TESTS.ssdResumeBig.test, result: 'ECHEC', detail: errorDetail(error) });
      lines.push(h('div', {}, 'Reprise sur gros fichier : échec.', errorBlock(error)));
    }
    extraResult.show('ok', 'Tests complémentaires terminés.', lines);
    return true;
  }

  /** Ouvre un gros fichier du dossier de test en keepExistingData, journalise et décrit. */
  async function probeResume(name: string, referenceOpenMs: number | null): Promise<string> {
    const ssd = state.ssd;
    if (!ssd) return '';
    const dir = await ssd.handle.getDirectoryHandle(TEST_DIR);
    const m = await measureResumeOpen(dir, name);
    const verdict = resumeOpenVerdict(m.size, m.openMs, referenceOpenMs);
    state.journal.add({
      step: STEP,
      test: CRITICAL_TESTS.ssdResumeBig.test,
      param: name,
      bytes: m.size,
      ms: m.openMs,
      result: 'INFO',
      detail: `${name} (${formatBytes(m.size)}) : ouverture ${formatDuration(m.openMs)}, abort ${formatDuration(m.abortMs)}${referenceOpenMs === null ? '' : `, référence petit fichier ${formatDuration(referenceOpenMs)}`}, ${verdict.kind === 'copy' ? 'recopie complète probable' : 'pas de recopie complète visible'}`,
    });
    return `Reprise sur ${name} : ${verdict.text}`;
  }

  /** Paliers de 1 Mo à 1 Go : s'arrête au premier échec après un second essai. */
  async function findLimit(): Promise<boolean> {
    const ssd = state.ssd;
    if (!ssd) {
      ladderResult.show('na', "Choisissez d'abord le dossier du SSD.");
      return false;
    }
    const chunkSize = chunk.read();
    step.setStatus('running');
    await ssd.backend.ensureDirectory(TEST_DIR);
    const dir = await ssd.handle.getDirectoryHandle(TEST_DIR);
    const attempts: LadderAttempt[] = [];
    const variants: VariantResult[] = [];
    const paint = (title: string) => ladderResult.show('running', title, [ladderTable(attempts), variantTable(variants)]);
    for (;;) {
      const action = nextLadderAction(attempts);
      if (action.kind === 'stop') break;
      const { size, attempt } = action;
      const name = ladderFileName(size);
      const param = `palier ${formatBytes(size)}, essai ${attempt}, morceaux ${formatBytes(Math.min(chunkSize, size))}`;
      paint(`Palier ${formatBytes(size)}${attempt > 1 ? ', second essai' : ''}...`);
      ladderProgress.start(`Palier ${formatBytes(size)}${attempt > 1 ? ' (second essai)' : ''}`, size);
      const started = performance.now();
      try {
        const m = await measureWritePattern(ssd.backend, joinPath(TEST_DIR, name), size, chunkSize, newSeed(), false, (done, meter) => ladderProgress.update(done, meter));
        const ok = m.bytes === size;
        attempts.push({ size, attempt, ok, bytes: m.bytes, openMs: m.openMs, writeMs: m.writeMs, closeMs: m.closeMs });
        state.journal.add({ step: STEP, test: CRITICAL_TESTS.ssdLadder.test, param, bytes: m.bytes, ms: attemptTotalMs(m), result: ok ? 'OK' : 'ECHEC', detail: writeDetail(m, size) });
      } catch (error) {
        const failure = failureOf(error, { phase: 'ouverture', target: size, elapsedMs: performance.now() - started });
        attempts.push({
          size,
          attempt,
          ok: false,
          bytes: failure.bytesWritten,
          openMs: failure.phaseMs['ouverture'] ?? 0,
          writeMs: failure.phaseMs['écriture'] ?? 0,
          closeMs: failure.phaseMs['close'] ?? 0,
          failure,
        });
        state.journal.add({ step: STEP, test: CRITICAL_TESTS.ssdLadder.test, param, bytes: failure.bytesWritten, ms: failure.elapsedMs, rate: null, result: 'ECHEC', detail: failureDetail(failure) });
      }
      ladderProgress.finish();
      const last = attempts[attempts.length - 1];
      if (size === VARIANT_SIZE && attempt === 1 && last?.ok) {
        for (const v of OPEN_VARIANTS) {
          paint(`Palier 16 Mo, variante : ${v.label}...`);
          const r = await measureOpenVariant(dir, v.value, v.file, VARIANT_SIZE, chunkSize);
          variants.push(r);
          const notes = r.notes.length > 0 ? `, ${r.notes.join(', ')}` : '';
          if (r.measure) {
            state.journal.add({ step: STEP, test: CRITICAL_TESTS.ssdVariant.test, param: v.label, bytes: r.measure.bytes, ms: attemptTotalMs(r.measure), result: r.measure.bytes === VARIANT_SIZE ? 'OK' : 'ECHEC', detail: writeDetail(r.measure, VARIANT_SIZE, notes) });
          } else if (r.failure) {
            state.journal.add({ step: STEP, test: CRITICAL_TESTS.ssdVariant.test, param: v.label, bytes: r.failure.bytesWritten, ms: r.failure.elapsedMs, rate: null, result: 'ECHEC', detail: `${failureDetail(r.failure)}${notes}` });
          } else {
            state.journal.add({ step: STEP, test: CRITICAL_TESTS.ssdVariant.test, param: v.label, result: 'NON DISPONIBLE', detail: r.notes.join(', ') });
          }
        }
      }
    }
    const extra: (string | Node)[] = [];
    // Coût d'une reprise sur le plus gros palier réussi de 256 Mo ou plus, avant nettoyage.
    const big = attempts.filter((a) => a.ok && a.size >= RESUME_PROBE_MIN).sort((a, b) => b.size - a.size)[0];
    if (big) {
      try {
        extra.push(await probeResume(ladderFileName(big.size), null));
      } catch (error) {
        state.journal.add({ step: STEP, test: CRITICAL_TESTS.ssdResumeBig.test, param: ladderFileName(big.size), result: 'ECHEC', detail: errorDetail(error) });
        extra.push(h('div', {}, 'Reprise sur gros fichier : échec.', errorBlock(error)));
      }
    }
    // Nettoyage : tout sauf le dernier palier en échec, laissé pour inspection.
    const { remove, keep } = ladderFilesToDelete(attempts);
    const removed: string[] = [];
    const notRemoved: string[] = [];
    for (const name of [...remove, ...OPEN_VARIANTS.map((v) => v.file)]) {
      try {
        await dir.removeEntry(name);
        removed.push(name);
      } catch (error) {
        if (errorInfo(error).name !== 'NotFoundError') notRemoved.push(`${name} (${errorInfo(error).name})`);
      }
    }
    state.journal.add({ step: STEP, test: 'nettoyage paliers', result: notRemoved.length === 0 ? 'OK' : 'ECHEC', detail: `supprimés : ${removed.join(' ') || 'aucun'}${notRemoved.length > 0 ? ` ; non supprimés : ${notRemoved.join(' ')}` : ''}${keep ? ` ; laissé pour inspection : ${keep}` : ''}` });

    const summary = summarizeLadder(attempts);
    const trend = closeTrend(attempts.filter((a) => a.ok).map((a) => ({ size: a.size, closeMs: a.closeMs, totalMs: attemptTotalMs(a) })));
    const kind = summary.smallestFail === null ? 'ok' : summary.largestOk !== null ? 'warn' : 'fail';
    step.setStatus(kind, kind === 'warn' ? 'Écriture limitée' : undefined);
    ladderResult.show(kind, describeLadder(summary), [
      summary.failure ? h('p', { class: 'fail-text' }, `${describeFailure(summary.failure)} (${summary.failure.errorName}).`) : '',
      ladderTable(attempts),
      h('p', { class: trend.kind === 'proportional' ? 'warn-text' : '' }, describeCloseTrend(trend)),
      variantTable(variants),
      ...extra,
      keep ? `Le fichier ${TEST_DIR}/${keep} (palier en échec) est laissé sur le SSD pour inspection : regardez sa taille dans l'explorateur de fichiers.` : 'Fichiers de palier supprimés.',
    ]);
    return summary.smallestFail === null;
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
    h('h3', {}, 'Taille limite d\'écriture'),
    h(
      'p',
      { class: 'muted' },
      `Écrit des fichiers de 1 Mo, 16 Mo, 64 Mo, 128 Mo, 256 Mo, 512 Mo puis 1 Go dans ${TEST_DIR}, avec la taille de morceaux choisie ci-dessus. S'arrête au premier échec après un second essai du même palier. Compte jusqu'à 15 minutes.`,
    ),
    actionButton('Chercher la taille limite', () => void runTest({ long: true, title: 'Recherche de la taille limite terminée' }, findLimit, fail(ladderResult))),
    ladderProgress.el,
    ladderResult.el,
    h('h3', {}, 'Tests complémentaires'),
    h('p', { class: 'muted' }, "Renommer un dossier (utile pour corriger un nom d'intervention), ajouter 1 Mo à un fichier existant, et mesurer l'ouverture d'une reprise sur un fichier de 256 Mo ou plus (coût de la reprise après coupure)."),
    actionButton('Tester renommage et reprise', () => void runTest({ long: true, title: 'Tests complémentaires terminés' }, extraTests, fail(extraResult)), 'secondary'),
    extraResult.el,
    h('h3', {}, 'Nettoyage'),
    h('p', { class: 'muted' }, `Supprime uniquement le dossier ${TEST_DIR} du SSD. À faire à la fin des tests.`),
    actionButton(`Supprimer ${TEST_DIR}`, () => void runTest({}, cleanup, fail(cleanResult)), 'danger'),
    cleanResult.el,
  );
  return step;
}

