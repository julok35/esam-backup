/*
 * Verdict de l'étape 0 et lignes d'analyse du résumé (fonctions pures, testées
 * par vitest). Tout se lit dans le journal : les écritures notent leur taille
 * visée (cible=), leur phase d'échec (phase=) et la durée de leur close().
 */
import { parseDetailMs, parseDetailNumber, parseFailurePhase, type FailurePhase } from './failure';
import { formatBytes, MIB } from './format';
import type { JournalEntry } from './journal-format';
import { closeTrend, describeCloseTrend, type ClosePoint } from './ladder';

/** Tests qui décident du verdict (section 4 du brief). */
export const CRITICAL_TESTS = {
  cardRead: { step: 1, test: 'lecture plus gros fichier' },
  ssdWrite: { step: 2, test: 'écriture fichier d\'essai' },
  ssdVerify: { step: 2, test: 'relecture et empreinte' },
  /** Une ligne par essai du test « Chercher la taille limite ». */
  ssdLadder: { step: 2, test: 'écriture par paliers' },
  /** Variantes d'ouverture au palier de 16 Mo. */
  ssdVariant: { step: 2, test: 'palier 16 Mo variante' },
  /** Ajout de 1 Mo à un fichier existant (createWritable keepExistingData). */
  ssdResume: { step: 2, test: 'reprise keepExistingData' },
  /** Ouverture keepExistingData sur un fichier de 256 Mo ou plus (non décisif). */
  ssdResumeBig: { step: 2, test: 'reprise gros fichier (ouverture)' },
} as const;

/** Tests d'écriture sur le SSD pris en compte pour la taille limite. */
const WRITE_TESTS: readonly string[] = [CRITICAL_TESTS.ssdWrite.test, CRITICAL_TESTS.ssdLadder.test, CRITICAL_TESTS.ssdVariant.test, CRITICAL_TESTS.ssdResume.test];

export interface WriteOutcome {
  test: string;
  /** Taille visée en octets. */
  target: number;
  ok: boolean;
  /** Octets réellement écrits (colonne taille du journal). */
  bytes: number | null;
  phase: FailurePhase | null;
  closeMs: number | null;
  totalMs: number | null;
}

/**
 * Écritures sur le SSD lues dans le journal, en ne gardant que la dernière
 * mesure par test et par taille visée. La taille visée vient de « cible= » ;
 * à défaut (anciens journaux) : 1 Mo pour la reprise, sinon la colonne taille.
 */
export function writeOutcomes(entries: readonly JournalEntry[]): WriteOutcome[] {
  const latest = new Map<string, WriteOutcome>();
  for (const e of entries) {
    if (e.step !== 2 || !WRITE_TESTS.includes(e.test) || (e.result !== 'OK' && e.result !== 'ECHEC')) continue;
    const target = parseDetailNumber(e.detail, 'cible') ?? (e.test === CRITICAL_TESTS.ssdResume.test ? MIB : e.bytes);
    if (target === null) continue;
    const key = `${e.test}|${target}|${e.test === CRITICAL_TESTS.ssdVariant.test ? e.param : ''}`;
    latest.delete(key);
    latest.set(key, {
      test: e.test,
      target,
      ok: e.result === 'OK',
      bytes: e.bytes,
      phase: parseFailurePhase(e.detail),
      closeMs: parseDetailMs(e.detail, 'close'),
      totalMs: e.ms,
    });
  }
  return [...latest.values()];
}

export type VerdictKind = 'validated' | 'limited' | 'rework' | 'incomplete';

export interface Verdict {
  kind: VerdictKind;
  text: string;
  /** Plus grande écriture réussie et plus petite en échec (octets), null si aucune. */
  largestOk: number | null;
  smallestFail: number | null;
  failurePhase: FailurePhase | null;
}

function lastEntry(entries: readonly JournalEntry[], spec: { step: number; test: string }): JournalEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.step === spec.step && e.test === spec.test) return e;
  }
  return undefined;
}

const failed = (e: JournalEntry | undefined) => e !== undefined && e.result !== 'OK' && e.result !== 'INFO';

/**
 * Verdict global, sur la dernière mesure de chaque test :
 * - à revoir : lecture de la carte en échec, relecture du SSD différente, ou
 *   aucune écriture sur le SSD réussie alors qu'au moins une a échoué ;
 * - écriture limitée : au moins une écriture réussie et une autre en échec ;
 * - validée : carte lue, fichier d'essai écrit et relu à l'identique ;
 * - incomplet sinon.
 */
export function computeVerdict(entries: readonly JournalEntry[]): Verdict {
  const card = lastEntry(entries, CRITICAL_TESTS.cardRead);
  const write = lastEntry(entries, CRITICAL_TESTS.ssdWrite);
  const verify = lastEntry(entries, CRITICAL_TESTS.ssdVerify);
  const outcomes = writeOutcomes(entries);
  const okSizes = outcomes.filter((o) => o.ok).map((o) => o.target);
  const fails = outcomes.filter((o) => !o.ok).sort((a, b) => a.target - b.target);
  const largestOk = okSizes.length > 0 ? Math.max(...okSizes) : null;
  const firstFail = fails[0];
  const smallestFail = firstFail ? firstFail.target : null;
  const failurePhase = firstFail ? firstFail.phase : null;
  const base = { largestOk, smallestFail, failurePhase };

  if (failed(card)) return { ...base, kind: 'rework', text: 'VERDICT : architecture à revoir (lecture de la carte en échec).' };
  if (failed(verify)) return { ...base, kind: 'rework', text: 'VERDICT : architecture à revoir (fichier relu sur le SSD différent du fichier écrit).' };
  if (firstFail && largestOk === null) {
    return { ...base, kind: 'rework', text: 'VERDICT : architecture à revoir (aucune écriture sur le SSD n\'a réussi).' };
  }
  if (firstFail && largestOk !== null) {
    const phase = failurePhase ? `, phase ${failurePhase}` : '';
    const label = largestOk < firstFail.target ? 'écriture limitée en taille : à analyser' : 'écriture irrégulière : à analyser';
    return {
      ...base,
      kind: 'limited',
      text: `VERDICT : ${label} (plus grande écriture réussie ${formatBytes(largestOk)}, plus petite en échec ${formatBytes(firstFail.target)}${phase}).`,
    };
  }
  if (card?.result === 'OK' && write?.result === 'OK' && verify?.result === 'OK') {
    return { ...base, kind: 'validated', text: 'VERDICT : architecture validée (carte lue, SSD écrit et relu à l\'identique).' };
  }
  return { ...base, kind: 'incomplete', text: 'VERDICT : incomplet (étapes 1 et 2 à terminer).' };
}

export function architectureVerdict(entries: readonly JournalEntry[]): string {
  return computeVerdict(entries).text;
}

/** Points du close() des écritures réussies (paliers et fichier d'essai). */
export function closePoints(entries: readonly JournalEntry[]): ClosePoint[] {
  return writeOutcomes(entries)
    .filter((o) => o.ok && o.closeMs !== null && o.totalMs !== null && o.test !== CRITICAL_TESTS.ssdResume.test)
    .map((o) => ({ size: o.target, closeMs: o.closeMs ?? 0, totalMs: o.totalMs ?? 0 }));
}

function persistenceLine(entries: readonly JournalEntry[]): string {
  const part = (prefix: string) =>
    (['Carte', 'SSD'] as const)
      .map((label) => {
        const e = lastEntry(entries, { step: 5, test: `${prefix} ${label}` });
        return e ? `${label} ${e.result}` : null;
      })
      .filter((s): s is string => s !== null);
  const atLoad = part('état au chargement');
  const verified = part('vérification');
  if (atLoad.length === 0 && verified.length === 0) return 'Persistance : pas encore testée.';
  const prompt = atLoad.some((s) => s.endsWith('À VÉRIFIER')) ? ' (Chrome redemande l\'accès à chaque ouverture, comportement normal)' : '';
  const load = atLoad.length > 0 ? `au chargement ${atLoad.join(', ')}${prompt}` : 'état au chargement non noté';
  const after = verified.length > 0 ? `après « Vérifier maintenant » ${verified.join(', ')}` : '« Vérifier maintenant » pas encore fait';
  return `Persistance : ${load} ; ${after}.`;
}

/**
 * Deux à quatre lignes d'analyse pour le résumé : tailles réussie et en échec,
 * comportement du close(), coût d'une reprise sur gros fichier, persistance.
 */
export function analysisLines(entries: readonly JournalEntry[]): string[] {
  const lines: string[] = [];
  const v = computeVerdict(entries);
  const outcomes = writeOutcomes(entries);
  if (outcomes.length === 0) {
    lines.push('Écriture sur le SSD : pas encore mesurée.');
  } else {
    const ok = v.largestOk === null ? 'aucune écriture réussie' : `plus grande écriture réussie ${formatBytes(v.largestOk)}`;
    let fail = 'aucune en échec';
    if (v.smallestFail !== null) {
      const first = outcomes.filter((o) => !o.ok && o.target === v.smallestFail)[0];
      const phase = first?.phase ? `phase ${first.phase}` : 'phase non notée';
      const done = first?.bytes !== null && first?.bytes !== undefined && first.phase ? `, après ${formatBytes(first.bytes)} écrits` : '';
      fail = `plus petite en échec ${formatBytes(v.smallestFail)} (${phase}${done})`;
    }
    lines.push(`Écriture sur le SSD : ${ok} ; ${fail}.`);
  }
  const points = closePoints(entries);
  if (points.length > 0) lines.push(describeCloseTrend(closeTrend(points)));
  const big = lastEntry(entries, CRITICAL_TESTS.ssdResumeBig);
  if (big && big.detail) lines.push(`Reprise sur gros fichier : ${big.detail}`);
  lines.push(persistenceLine(entries));
  return lines;
}
