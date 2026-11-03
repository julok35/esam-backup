/*
 * Signal de fin de traitement : notification et vibration.
 * Sur Chrome Android, new Notification() est interdit : il faut passer par le
 * service worker (registration.showNotification), d'où le repli ci-dessous.
 */

export type NotifyPermission = NotificationPermission | 'unsupported';

export function notificationPermission(): NotifyPermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/** À appeler depuis un geste de l'utilisateur (ex. au lancement d'un import). */
export async function requestNotificationPermission(): Promise<NotifyPermission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

/** Motifs de vibration (millisecondes vibration / pause). */
export const VIBRATION = {
  success: [200, 100, 200],
  nothingNew: [150],
  error: [600, 200, 600, 200, 600],
} as const;

export function vibrate(pattern: readonly number[]): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  return navigator.vibrate([...pattern]);
}

export interface FinishSignal {
  title: string;
  body: string;
  vibration?: readonly number[];
  /** Regroupe les notifications : une nouvelle remplace l'ancienne de même tag. */
  tag?: string;
}

/** Notifie la fin d'un traitement. Ne lève jamais : renvoie ce qui a pu être fait. */
export async function signalFinished(signal: FinishSignal): Promise<{ notified: boolean; vibrated: boolean }> {
  const vibrated = vibrate(signal.vibration ?? VIBRATION.success);
  let notified = false;
  if (notificationPermission() === 'granted') {
    const options: NotificationOptions = { body: signal.body, tag: signal.tag ?? 'esam-fin' };
    try {
      const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
      if (registration) {
        await registration.showNotification(signal.title, options);
      } else {
        new Notification(signal.title, options);
      }
      notified = true;
    } catch {
      notified = false;
    }
  }
  return { notified, vibrated };
}
