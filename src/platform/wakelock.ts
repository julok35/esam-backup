/*
 * Maintien de l'écran allumé pendant un traitement. Le navigateur relâche le verrou
 * quand la page passe en arrière-plan : il est redemandé au retour (visibilitychange).
 */

export class ScreenWakeLock {
  #sentinel: WakeLockSentinel | null = null;
  #wanted = false;
  readonly #onVisibility = (): void => {
    if (this.#wanted && document.visibilityState === 'visible' && this.#sentinel === null) {
      void this.#request();
    }
  };

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  get active(): boolean {
    return this.#sentinel !== null;
  }

  /** Demande le verrou. Renvoie false si le navigateur refuse ou ne sait pas faire. */
  async acquire(): Promise<boolean> {
    if (!this.#wanted) {
      this.#wanted = true;
      document.addEventListener('visibilitychange', this.#onVisibility);
    }
    return this.#request();
  }

  async release(): Promise<void> {
    this.#wanted = false;
    document.removeEventListener('visibilitychange', this.#onVisibility);
    const sentinel = this.#sentinel;
    this.#sentinel = null;
    await sentinel?.release().catch(() => undefined);
  }

  async #request(): Promise<boolean> {
    if (!ScreenWakeLock.isSupported() || document.visibilityState !== 'visible') return false;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => {
        if (this.#sentinel === sentinel) this.#sentinel = null;
      });
      this.#sentinel = sentinel;
      return true;
    } catch {
      return false;
    }
  }
}
