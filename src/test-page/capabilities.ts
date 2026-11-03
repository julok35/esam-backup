/*
 * Étape 0 : capacités du navigateur, détectées au chargement sans action.
 */
import { capabilityVerdict, errorDetail, type CapabilityItem, type CapabilityVerdict } from './analysis';
import { chromeMajorFromUserAgent, detectCapabilities } from './capabilities-detect';
import { state } from './context';
import { formatBytes } from './format';
import { actionButton, badge, createStep, errorBlock, rawBlock, resultArea, type Step } from './ui';
import { notificationPermission, requestNotificationPermission, signalFinished, VIBRATION } from '../platform';
import { h, render } from '../ui/dom';

interface UADataLike {
  brands?: { brand: string; version: string }[];
  mobile?: boolean;
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
}

function itemBadge(item: CapabilityItem) {
  if (item.present === null) return badge('todo', 'Info');
  if (item.present) return badge('ok', 'Oui');
  return item.level === 'critical' ? badge('fail', 'Non') : badge('na', 'Non');
}

const LEVEL_TEXT: Record<CapabilityItem['level'], string> = {
  critical: 'indispensable',
  important: 'important',
  useful: 'utile',
  info: 'information',
};

/** Informations sur l'appareil (modèle, version de Chrome) via userAgentData. */
async function deviceInfo(): Promise<{ label: string; raw: Record<string, unknown> }> {
  const uaData = (navigator as Navigator & { userAgentData?: UADataLike }).userAgentData;
  const raw: Record<string, unknown> = { userAgent: navigator.userAgent };
  let model = '';
  let chrome = chromeMajorFromUserAgent(navigator.userAgent);
  let chromeFull = '';
  if (uaData) {
    raw.brands = uaData.brands;
    raw.mobile = uaData.mobile;
    raw.platform = uaData.platform;
    if (typeof uaData.getHighEntropyValues === 'function') {
      try {
        const high = await uaData.getHighEntropyValues(['model', 'platformVersion', 'fullVersionList', 'architecture']);
        raw.highEntropy = high;
        model = typeof high.model === 'string' ? high.model : '';
        const list = Array.isArray(high.fullVersionList) ? (high.fullVersionList as { brand: string; version: string }[]) : [];
        const entry = list.find((b) => /Chrom/i.test(b.brand) && !/Not/i.test(b.brand));
        if (entry) {
          chromeFull = entry.version;
          chrome = Number.parseInt(entry.version, 10);
        }
      } catch (error) {
        raw.highEntropyError = errorDetail(error);
      }
    }
  }
  const label = `${model || 'modèle inconnu'}, Chrome ${chromeFull || chrome || '?'}`;
  return { label, raw };
}

async function storageInfo(): Promise<Record<string, unknown>> {
  const info: Record<string, unknown> = {};
  try {
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      info.estimation = `${formatBytes(estimate.usage ?? 0)} utilisés sur ${formatBytes(estimate.quota ?? 0)} (stockage interne du navigateur, pas le SSD)`;
    }
    if (navigator.storage?.persisted) info.persistant = await navigator.storage.persisted();
  } catch (error) {
    info.erreur = errorDetail(error);
  }
  return info;
}

export interface CapabilitiesStep {
  step: Step;
  verdict: CapabilityVerdict;
}

export function createCapabilitiesStep(): CapabilitiesStep {
  const step = createStep(
    0,
    'Capacités du navigateur',
    "Vérifié automatiquement à l'ouverture de la page. Rien à faire, sauf autoriser les notifications pour être prévenu de la fin des tests longs.",
    true,
  );
  const items = detectCapabilities(globalThis as unknown as Record<string, unknown>);
  const verdict = capabilityVerdict(items);
  const result = resultArea();
  const deviceLine = h('p', { class: 'device' }, 'Appareil : lecture en cours...');
  const list = h(
    'ul',
    { class: 'caps' },
    ...items.map((item) =>
      h('li', {}, itemBadge(item), h('span', { class: 'cap-label' }, item.label, h('small', { class: 'muted' }, ` (${LEVEL_TEXT[item.level]})`), item.value ? h('small', { class: 'mono muted cap-value' }, item.value) : null)),
    ),
  );

  if (verdict.blocking) {
    step.setStatus('fail', 'Bloquant');
    result.show('fail', "Choix de dossier impossible sur ce navigateur : l'architecture est à revoir.", ['Les tests de repli de l\'étape 1 restent possibles pour mesurer la lecture.']);
  } else if (verdict.missingImportant.length > 0) {
    step.setStatus('warn');
    result.show('warn', 'Choix de dossier disponible, mais des fonctions importantes manquent.', verdict.missingImportant.map((m) => `Absent : ${m}`));
  } else {
    step.setStatus('ok');
    result.show('ok', 'Toutes les fonctions indispensables sont présentes.', verdict.missingUseful.length > 0 ? verdict.missingUseful.map((m) => `Absent (utile) : ${m}`) : []);
  }

  const notifState = h('p', { class: 'muted' });
  const showNotif = () => {
    const p = notificationPermission();
    notifState.textContent = `Notifications : ${p === 'granted' ? 'autorisées' : p === 'denied' ? 'refusées (à changer dans les réglages du site)' : p === 'unsupported' ? 'non disponibles' : 'pas encore demandées'}.`;
  };
  showNotif();
  const signalArea = h('div', {});
  const notifButton = actionButton(
    'Autoriser les notifications et tester la vibration',
    () => {
      void (async () => {
        try {
          await requestNotificationPermission();
          showNotif();
          const done = await signalFinished({ title: 'ESAM étape 0', body: 'Essai de notification de fin de test.', vibration: VIBRATION.success, tag: 'esam-etape0' });
          render(signalArea, h('p', {}, `Notification affichée : ${done.notified ? 'oui' : 'non'}. Vibration : ${done.vibrated ? 'oui' : 'non'}.`));
          state.journal.add({
            step: 0,
            test: 'notification et vibration',
            result: done.notified || done.vibrated ? 'OK' : 'NON DISPONIBLE',
            detail: `notification=${done.notified} vibration=${done.vibrated} permission=${notificationPermission()}`,
          });
        } catch (error) {
          render(signalArea, errorBlock(error));
        }
      })();
    },
    'secondary',
  );

  const rawHolder = h('div', {});
  step.body.append(result.el, deviceLine, list, notifState, notifButton, signalArea, rawHolder);

  void (async () => {
    const device = await deviceInfo();
    state.device = device.label;
    deviceLine.textContent = `Appareil : ${device.label}`;
    const storage = await storageInfo();
    render(rawHolder, rawBlock({ appareil: device.raw, stockage: storage, capacites: items }));
    // Une ligne de journal par ouverture de page : utile pour comparer les versions de Chrome.
    state.journal.add({
      step: 0,
      test: 'capacités',
      param: device.label,
      result: verdict.blocking ? 'ECHEC' : 'OK',
      detail: items
        .filter((i) => i.present !== null)
        .map((i) => `${i.id}=${i.present ? 'oui' : 'non'}`)
        .join(' '),
    });
  })();

  return { step, verdict };
}
