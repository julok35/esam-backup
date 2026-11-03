/*
 * Page de test de l'étape 0 (brief, section 4) : vérifie sur le S24 Ultra que la
 * carte se lit, que le SSD s'écrit, mesure les débits, l'identification de la
 * carte et la tenue des poignées. Résultats à l'écran, en CSV et en résumé.
 */
import '../ui/base.css';
import './test-page.css';
import { ARCHITECTURE_BANNER, ARCHITECTURE_FAILURE_BANNER, BRAVE_BANNER, WRITE_LIMIT_BANNER } from './analysis';
import { createCapabilitiesStep } from './capabilities';
import { createCardStep } from './card-tests';
import { state, TEST_DIR } from './context';
import { createIdentityStep } from './identity';
import { createJournalSection } from './journal-ui';
import { computeVerdict } from './journal-format';
import { createPersistenceStep } from './persistence';
import { createSsdStep } from './ssd-tests';
import { createThroughputStep } from './throughput';
import { registerServiceWorker } from '../platform/sw-register';
import { $, h, render } from '../ui/dom';

const base = import.meta.env.BASE_URL;

const banner = h('div', { class: 'banner', role: 'alert', hidden: true });
const capabilities = createCapabilitiesStep();

function updateBanner(): void {
  const verdict = computeVerdict(state.journal.entries);
  let text = '';
  let warn = false;
  if (capabilities.verdict.blocking && capabilities.brave) text = BRAVE_BANNER;
  else if (capabilities.verdict.blocking) text = ARCHITECTURE_BANNER;
  else if (verdict.kind === 'rework') text = ARCHITECTURE_FAILURE_BANNER;
  else if (verdict.kind === 'limited') {
    // Orange et non rouge : de petites écritures passent, la limite reste à comprendre.
    warn = true;
    const head = verdict.text.replace(/^VERDICT : /, '');
    text = `${head.charAt(0).toUpperCase()}${head.slice(1)} ${WRITE_LIMIT_BANNER}`;
  }
  banner.classList.toggle('banner-warn', warn);
  banner.hidden = text === '';
  banner.textContent = text;
}

render(
  $('#app'),
  h('header', { class: 'page-header' }, h('h1', {}, 'Page de test - étape 0'), h('p', { class: 'muted' }, `ESAM Sauvegarde, version ${__BUILD_ID__}`)),
  banner,
  h(
    'div',
    { class: 'card intro' },
    h('p', {}, 'Faites les étapes dans l\'ordre, en ouvrant chacune d\'un appui sur son titre. Chaque mesure est notée dans le journal en bas de page, exportable en CSV.'),
    h('p', { class: 'muted' }, `La carte est toujours ouverte en lecture seule. Sur le SSD, la page n'écrit que dans le dossier ${TEST_DIR}.`),
  ),
  capabilities.step.root,
  createCardStep(capabilities.verdict.blocking).root,
  createSsdStep().root,
  createThroughputStep().root,
  createIdentityStep().root,
  createPersistenceStep().root,
  createJournalSection(),
  h('a', { class: 'btn', href: base }, "Retour à l'accueil de l'appli"),
);

state.journal.onChange(updateBanner);
updateBanner();

void registerServiceWorker();
