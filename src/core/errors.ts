/*
 * Erreurs de la logique pure. Chaque erreur porte un code stable (pour le code
 * appelant) et un message pour l'utilisateur, en français et sans jargon : dire
 * quoi faire, pas ce qui a échoué en interne. Le détail technique reste dans
 * `message` (journaux, rapport de bogue).
 */

export type CoreErrorCode =
  | 'invalid-date'
  | 'invalid-index'
  | 'invalid-manifest'
  | 'invalid-entry'
  | 'confirmation-required'
  | 'not-archived'
  | 'already-free'
  | 'pending-new-content';

const USER_MESSAGES: Record<CoreErrorCode, string> = {
  'invalid-date': 'La date saisie est incorrecte. Saisissez-la sous la forme 2026-10-18.',
  'invalid-index':
    "Le fichier d'index des sauvegardes est abîmé. Les médias du SSD ne sont pas touchés : relancez une vérification complète pour reconstruire l'index.",
  'invalid-manifest':
    "Le fichier de description de l'intervention (_esam.json) est abîmé. Les médias ne sont pas touchés : il sera recréé au prochain import.",
  'invalid-entry': 'Une information enregistrée est incomplète. Réessayez ; si le problème revient, relancez une vérification complète.',
  'confirmation-required':
    'Confirmez d\'abord que les médias de cette carte sont copiés ailleurs que sur le SSD.',
  'not-archived': 'Cette carte doit d\'abord être marquée « archivée » avant de pouvoir être formatée.',
  'already-free': 'Cette carte est déjà marquée « libre ».',
  'pending-new-content':
    'De nouveaux fichiers sont présents sur cette carte : sauvegardez-la d\'abord, puis marquez-la archivée.',
};

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly userMessage: string;

  constructor(code: CoreErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'CoreError';
    this.code = code;
    this.userMessage = USER_MESSAGES[code];
  }
}
