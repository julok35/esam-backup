# src/core : logique pure

Fonctions et types purs, déterministes, sans DOM, sans API navigateur, sans Node et
sans dépendance. Aucun accès aux fichiers : les entrées sont des objets simples (nom,
taille, date de modification, empreinte), jamais des poignées. Aucune date « cachée » :
l'instant présent est toujours passé en paramètre (`now`, `at`). Aucun argument n'est
modifié : chaque fonction retourne une nouvelle valeur.

Import : `import { planImport, normalizeInterventionName } from '../core'`.
Tests : `tests/core/*.test.ts` (un fichier par module), fixtures SRT dans
`tests/core/fixtures/`.

| Module | Lot | Contenu |
|---|---|---|
| `format.ts` | tous | `formatBytes` (« 1,2 Go », unités décimales), `formatDuration`, `formatRate` (Mo/s), `bytesPerSecond`, `isoDate` et `todayIso` (heure locale), `isValidIsoDate`, `daysBetween` |
| `errors.ts` | tous | `CoreError` : `code` stable pour le programme, `userMessage` en français pour l'écran |
| `naming.ts` | 1, 3 | Règles de nommage de la section 6 : nom d'intervention, nom de repli, lecture tolérante des noms du Drive, date la plus fréquente, dossiers proches, sous-dossier source, arborescence `ESAM/01 - Secours/<année>/...`, suffixes `_2`, `_3` |
| `media-index.ts` | 2 | Index des empreintes (JSON versionné), pré-tri rapide, plan d'import, décision après hachage, contrôle de cohérence |
| `card.ts` | 2 | Empreinte de carte (FNV-1a 64 bits), reconnaissance exacte ou tolérante, statuts sauvegardée, archivée, libre, santé des cartes |
| `srt.ts` | 7 | Lecture des SRT DJI (M30T et variantes), export GPX et KML, résumé de trace |
| `manifest.ts` | 7 | Manifeste `_esam.json` par dossier d'intervention, type de fichier d'après son nom |
| `index.ts` | | Réexports |

## Nommage (`naming.ts`)

- `normalizeInterventionName({ date, animals, place })` : `2026-10-18 Dolly et Max - Mont Granier`.
  Accents composés (NFC), tirets typographiques convertis, caractères interdits sur
  exFAT et Drive (`\ / : * ? " < > |`, contrôles) remplacés par une espace, espaces
  réduites, 120 caractères au plus. Retourne `null` si animal et lieu sont vides
  (utiliser `fallbackInterventionName`) ; une seule partie vide devient « à préciser ».
- `fallbackInterventionName(date, n)` et `nextFallbackNumber(noms, date)` : plus grand N
  de la journée plus 1, jamais de réutilisation.
- `parseInterventionName(nom)` : accepte `2026.10.18`, `18-10-2026`, `18/10/2026`,
  `20261018`, point après la date, `-` sans espaces ; propose `normalized`.
- `mostFrequentCaptureDate(dates, now)` : ignore les horloges déréglées (avant 2016 ou
  dans le futur) ; égalité : la plus récente.
- `findNearbyInterventions(noms, date, 3)`, `sourceFolderName(saisie, n)`,
  `nextImportNumber`, `yearFolder`, `interventionPath`, `systemPath`.
- `resolveFileNameCollision(nom, existants)` : comparaison insensible à la casse
  (exFAT), extension conservée, extensions doubles connues (`.tar.gz`).

## Index et dédoublonnage (`media-index.ts`)

Flux prévu pour l'import (lots 1 et 2) :

1. `parseIndex` (fichier `ESAM/_systeme/index-empreintes.json`) ; en cas d'erreur,
   afficher `userMessage` et proposer la vérification complète.
2. `planImport(index, fichiersDeLaCarte, { fullVerification })` : `copy`,
   `skip-quick` (écarté sans relecture, emplacement dans `match`) ou
   `hash-then-decide`. `nothingNew` donne « rien de nouveau » sans relire la carte.
3. Pour chaque fichier lu : empreinte calculée pendant la lecture, puis
   `decideAfterHash(index, fichier, sha, nomsDuDossierCible)` : `duplicate`
   (« déjà sauvegardé », emplacement existant), `copy-as` (nom suffixé) ou `copy`.
   Pour `copy`, la copie se fait sous un nom temporaire et la décision est prise à
   la fin de la lecture (le contenu peut déjà exister sous un autre nom).
4. `addEntry` pour chaque fichier copié, `serializeIndex`, puis
   `verifyConsistency(attendus, relus)` sur le SSD.

## Cartes (`card.ts`)

- `cardFingerprint({ volumeName, oldestFiles })` : nom du volume et 10 fichiers les
  plus anciens (nom, taille, date à la seconde), identifiant `carte-<16 hex>`.
- `matchCard(cartes, empreinte)` : exacte, sinon même volume et au moins 7 des 10
  fichiers anciens retrouvés (70 % pour une carte de moins de 10 fichiers).
- `createCardRecord`, `transitionCard(carte, action)` : `import-ok`, `mark-archived`
  (`confirmed: true` obligatoire), `mark-free` (depuis archivée seulement),
  `new-content-seen` (une carte archivée ou libre repasse à sauvegardée). Transition
  interdite : `CardTransitionError` (code, statut de départ, message).
- `displayStatus` : « Ne pas formater » tant que la carte n'est pas libre.
- `recordImportStats`, `assessCardHealth` : alerte si les erreurs de lecture
  augmentent sur les 3 derniers imports, ou si leur débit médian passe sous 60 % de
  la médiane des imports précédents (seuils paramétrables, petits imports ignorés).

## SRT, GPX, KML (`srt.ts`)

Le format supposé et les variantes tolérées sont décrits en tête du module. L'heure
écrite dans les SRT est l'heure locale de l'appareil : passer `utcOffsetMinutes`
si elle diffère du fuseau du téléphone. `toGpx` et `toKml` acceptent `thinning: true`
(un point par seconde au lieu de 30).
