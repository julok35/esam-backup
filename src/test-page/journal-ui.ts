/*
 * Section « Journal et export » : dernières mesures, export CSV (téléchargement
 * ou partage), copie du résumé, effacement.
 */
import { errorDetail } from './analysis';
import { state } from './context';
import { describeEntry, STEP_TITLES } from './journal-format';
import { canShareCsv, copyText, downloadCsv, shareCsv } from './journal';
import { actionButton, badge, errorBlock, resultArea, type StatusKind } from './ui';
import { h, render } from '../ui/dom';

const RESULT_KIND: Record<string, StatusKind> = { OK: 'ok', ECHEC: 'fail', 'NON DISPONIBLE': 'na', INFO: 'todo', 'À VÉRIFIER': 'warn' };

export function createJournalSection(): HTMLElement {
  const count = h('span', { class: 'step-status' });
  const list = h('ol', { class: 'journal-list', reversed: true });
  const feedback = resultArea();
  const persistNote = h('p', { class: 'muted' });

  state.journal.onChange((entries) => {
    render(count, badge('todo', `${entries.length} mesure${entries.length > 1 ? 's' : ''}`));
    const recent = entries.slice(-30).reverse();
    render(
      list,
      ...recent.map((e) =>
        h('li', {}, badge(RESULT_KIND[e.result] ?? 'todo', e.result), ' ', h('strong', {}, `Étape ${e.step}`), ` ${describeEntry(e).slice(e.result.length + 1)}`, h('small', { class: 'muted mono' }, ` ${e.ts}`)),
      ),
    );
    persistNote.textContent = state.journal.persistent
      ? 'Le journal est conservé dans ce navigateur, même après rechargement de la page.'
      : "Attention : ce navigateur ne conserve pas le journal. Exportez-le avant de recharger la page.";
  });

  const exportCsv = actionButton('Exporter en CSV', () => {
    try {
      const name = downloadCsv(state.journal);
      feedback.show('ok', `Fichier ${name} téléchargé (dossier Téléchargements).`);
    } catch (error) {
      feedback.show('fail', 'Export impossible.', [errorBlock(error)]);
    }
  });
  const share = actionButton(
    'Envoyer le CSV (mail, Drive...)',
    () => {
      void shareCsv(state.journal).then(
        () => feedback.show('ok', 'CSV transmis au menu de partage.'),
        (error: unknown) => {
          if (errorDetail(error).startsWith('AbortError')) feedback.show('warn', 'Partage annulé.');
          else feedback.show('fail', 'Partage impossible.', [errorBlock(error)]);
        },
      );
    },
    'secondary',
  );
  share.hidden = !canShareCsv();
  const copy = actionButton(
    'Copier le résumé',
    () => {
      void copyText(state.journal.summary(state.device, __BUILD_ID__)).then(
        () => feedback.show('ok', 'Résumé copié : collez-le dans un mail ou un message.'),
        (error: unknown) => feedback.show('fail', 'Copie impossible.', [errorBlock(error)]),
      );
    },
    'secondary',
  );
  const clear = actionButton(
    'Effacer le journal',
    () => {
      if (!window.confirm('Effacer toutes les mesures du journal ? Pensez à exporter le CSV avant.')) return;
      state.journal.clear();
      feedback.show('ok', 'Journal effacé.');
    },
    'danger',
  );

  return h(
    'details',
    { class: 'step', id: 'journal' },
    h('summary', {}, h('span', { class: 'step-num' }, 'J'), h('span', { class: 'step-title' }, 'Journal et export'), count),
    h(
      'div',
      { class: 'step-body' },
      h('p', { class: 'muted' }, `Une ligne par mesure. Étapes : ${Object.entries(STEP_TITLES).map(([n, t]) => `${n} ${t}`).join(', ')}.`),
      persistNote,
      exportCsv,
      share,
      copy,
      feedback.el,
      list,
      clear,
    ),
  );
}
