# CLAUDE.md - ESAM Sauvegarde

## Contexte

L'ESAM (Equipe de Secours Animalier en Montagne) doit sécuriser au plus vite les
cartes mémoire en fin d'intervention (drone DJI M30T, caméras, téléphones) sur un SSD
branché au Samsung S24 Ultra de Julien, seul développeur et utilisateur pilote.
Brief complet : `ESAM_Brief_ClaudeCode_Sauvegarde.md` (v0.2), hors dépôt.

## Architecture

- **PWA statique** (Vite + TypeScript, sans framework UI, DOM direct), hébergée sur
  **GitHub Pages** à https://julok35.github.io/esam-backup/ (base `/esam-backup/` en
  build, `/` en dev). Aucun serveur. Service worker écrit à la main (`public/sw.js`)
  pour le fonctionnement hors réseau.
- **File System Access** (`showDirectoryPicker`) pour lire la carte et écrire sur le
  SSD. Poignées de dossiers conservées dans IndexedDB.
- **hash-wasm** pour le SHA-256 en flux (WebCrypto ne hache pas par morceaux).
- **WebRTC** (canal de données) pour recevoir les médias des autres téléphones :
  lot 4, plus tard.
- **Couche de stockage abstraite** (`src/storage`) : SSD aujourd'hui
  (`FsaDirectoryBackend`), Google Drive plus tard (`DriveBackend`, non écrit, contrat
  décrit dans `src/storage/types.ts`).
- Wake Lock pendant les traitements, notification et vibration à la fin.

## Arborescence

```
index.html                 coquille de l'appli (écran d'accueil)
test/index.html            page de test de l'étape 0
public/                    copié tel quel : manifest.webmanifest, sw.js, icons/
scripts/                   check-typo.mjs (règle des tirets), make-icons.mjs
src/app/                   point d'entrée de la coquille
src/test-page/             point d'entrée de la page de test
src/core/                  logique pure, sans DOM ni API navigateur (testée par vitest)
src/storage/               StorageBackend, FsaDirectoryBackend, ReadOnlySource
src/platform/              handles (IndexedDB, permissions), hash, wakelock, notify, sw-register
src/ui/                    base.css (styles communs), dom.ts (helpers h, $, render)
src/types/                 compléments de types (File System Access, __BUILD_ID__)
tests/                     tests vitest (*.test.ts), faux système de fichiers dans helpers/
docs/                      tests manuels par lot, fiche d'usage
.github/workflows/         deploy.yml (main vers Pages), ci.yml (autres branches, PR)
```

Imports : `import { ReadOnlySource, FsaDirectoryBackend } from '../storage'` et
`import { StreamingSha256, ScreenWakeLock, saveHandle } from '../platform'`
(chemins relatifs, pas d'alias).

Ajouter une page : créer `<nom>/index.html` qui charge `/src/<nom>/main.ts`, puis
l'ajouter dans `build.rolldownOptions.input` de `vite.config.ts`. Le service worker
la met en cache automatiquement (liste `precache.json` générée au build).

## Règles de nommage du SSD

Convention du Drive existant : `AAAA-MM-JJ Animal(aux) - Lieu`
(ex. `2026-10-18 Dolly et Max - Mont Granier`).

- Arborescence : `ESAM/01 - Secours/<année>/<intervention>/<source>/`.
- Index, statuts des cartes et journaux : `ESAM/_systeme/`.
- **Dossier d'intervention** : date préremplie avec la date de prise de vue la plus
  fréquente des médias, sinon la date du jour ; animal et lieu saisis.
  Normalisation : date ISO, séparateur ` - ` entre animal et lieu, espaces simples,
  pas de point après la date. Saisie vide ou doute :
  `AAAA-MM-JJ Sauvegarde intervention N - à renommer` (N incrémenté dans la journée).
  Avant toute création, proposer de se rattacher à un dossier existant de la même
  date ou des trois jours précédents.
- **Sous-dossier source** : prénom ou nom de l'appareil saisi à chaque import
  (ex. `Drone M30T`, `Kévin`). Saisie vide : `ImportN - à renommer`.
- **Fichiers** : noms d'origine conservés. Suffixe `_2`, `_3` uniquement en cas de
  collision de nom avec un contenu différent. Contenu identique : pas de copie,
  signalé « déjà sauvegardé ». Aucun écrasement possible.
- Renommage ultérieur d'un dossier possible depuis l'appli.

## Règle absolue : aucune écriture sur une carte source

- La carte est toujours ouverte en `ReadOnlySource` (`src/storage/read-only-source.ts`),
  jamais en `FsaDirectoryBackend`. Le code d'import reçoit un `ReadableStorage` pour
  la carte : il n'a aucune méthode d'écriture à appeler.
- `ReadOnlySource` garde la poignée dans un champ privé (`#root`), est gelée
  (`Object.freeze`), et ne lit que via `src/storage/fsa-read.ts` (jamais
  `{ create: true }`, `createWritable`, `removeEntry` ni `move`).
- Permission demandée en mode `read` pour la carte, `readwrite` pour le SSD seulement.
- Pas de fichier témoin, de journal ni d'identifiant écrit sur la carte : la carte
  est reconnue par son empreinte (nom du volume, fichiers les plus anciens).
- `tests/read-only-source.test.ts` vérifie tout cela, y compris à la compilation
  (une `ReadOnlySource` n'est pas assignable à `StorageBackend`).

## Conventions de code

- TypeScript strict (`noUncheckedIndexedAccess` compris), cible ES2022.
- Identifiants en anglais ; chaînes d'interface, commentaires et documentation en
  français.
- Messages utilisateur sans jargon technique : dire quoi faire, pas ce qui a échoué
  en interne (voir `StorageError.userMessage`).
- **Jamais de tiret cadratin ni demi-cadratin**, uniquement `-`, partout (code,
  interface, documentation, commits). Contrôlé par `npm run check:typo` en CI.
- Dépendances minimales : seule dépendance de production `hash-wasm`. Toute nouvelle
  dépendance doit être justifiée.
- `src/core` : logique pure, testée par vitest. Pas d'accès au DOM ni aux API
  navigateur, pour rester testable sous Node.
- Interface : une action principale par écran, boutons de 56 px minimum, fort
  contraste, thème sombre (`src/ui/base.css`).
- Pour chaque lot, une liste de tests manuels sur le S24 Ultra avec critères de
  réussite dans `docs/`.

## Commandes

| Commande | Effet |
|---|---|
| `npm run dev` | serveur de développement (base `/`) |
| `npm run build` | build de production dans `dist/` (base `/esam-backup/`) |
| `npm run preview` | sert `dist/` sous `/esam-backup/` |
| `npm test` | tests vitest une fois |
| `npm run test:watch` | tests vitest en continu |
| `npm run typecheck` | `tsc --noEmit` sur `src` puis sur les fichiers Node (config, tests) |
| `npm run check:typo` | refuse tout tiret cadratin ou demi-cadratin |
| `npm run check` | typecheck puis check:typo |

Déploiement : push sur `main`, le workflow publie sur GitHub Pages (Settings, Pages,
Source : GitHub Actions).

## Hors périmètre

- Envoi vers Google Drive et tout accès à un compte Google (section 7 du brief :
  prévu par la couche de stockage, pas codé).
- Écriture ou formatage des cartes.
- Import en arrière-plan écran éteint (impossible en web).
- Montage vidéo, diffusion publique, chiffrement, numéro Pat'rouille, boîtier
  Raspberry Pi.

## État d'avancement

- [x] Socle technique : Vite, TypeScript, tests, service worker, déploiement, couche
  de stockage, utilitaires plateforme.
- [ ] **Étape 0 en cours** : page de test (bloquante). Si la lecture de la carte ou
  l'écriture sur le SSD échoue, arrêter : l'architecture est à revoir.
  Page de test livrée (`test/`, `src/test-page/`, protocole
  `docs/etape-0-tests-manuels.md`) : résultats du S24 Ultra attendus (CSV).
  Premiers résultats du 03/11 : lecture OK, écriture 1 Mo OK, 1 Go en échec, move absent, confirmation d'accès à chaque ouverture (test par paliers ajouté pour trouver la limite).
- [ ] Lots 1 à 7, dans l'ordre, chacun utilisable seul.

Points à lever à l'étape 0 : identification des cartes sans identifiant de volume,
validité des poignées après rebranchement, prise en charge de `move()` pour renommer
un dossier sur le SSD, coût de `createWritable({ keepExistingData: true })` pour la
reprise sur de gros fichiers.
