import '../ui/base.css';
import { registerServiceWorker } from '../platform/sw-register';
import { $, h, render } from '../ui/dom';

const base = import.meta.env.BASE_URL;

render(
  $('#app'),
  h('h1', {}, 'ESAM Sauvegarde'),
  h(
    'div',
    { class: 'card' },
    h('p', {}, "L'appli est en préparation."),
    h(
      'p',
      { class: 'muted' },
      "Étape en cours : vérifier que ce téléphone sait lire une carte et écrire sur le SSD. Branchez le lecteur de carte et le SSD, puis ouvrez la page de test.",
    ),
  ),
  h('a', { class: 'btn btn-primary', href: `${base}test/` }, 'Ouvrir la page de test'),
);

void registerServiceWorker();
