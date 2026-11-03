# Documentation ESAM Sauvegarde

Ce dossier rassemble la documentation d'usage et de recette. La documentation
technique pour le développement est dans [`CLAUDE.md`](../CLAUDE.md) à la racine.

## Documents

- [`etape-0-tests-manuels.md`](etape-0-tests-manuels.md) : protocole de l'étape 0
  sur le S24 Ultra avec la page de test (`/test/`), critères de réussite et
  d'arrêt, grille de résultats à remplir.

## Ce qu'on y met

- **Tests manuels par lot**, à faire sur le Samsung S24 Ultra avec le hub, le
  lecteur de cartes et le SSD. Un fichier par étape ou par lot, par exemple
  `tests-manuels-etape-0.md`, `tests-manuels-lot-1.md`. Chaque test indique :
  le matériel branché, les gestes à faire, le résultat attendu (critère de
  réussite), et une case pour noter le résultat obtenu et la date.
- **Fiche d'usage** (`fiche-usage.md`) : une page, pour Julien sur le terrain.
  Les gestes dans l'ordre, sans jargon, avec ce qu'il faut faire en cas de
  problème. Elle doit tenir sur une page imprimée.
- **Résultats de l'étape 0** : export CSV de la page de test et conclusions
  (débits mesurés, identification des cartes, tenue des autorisations après
  rebranchement).

## Règles

- Tout en français, sans jargon technique.
- Jamais de tiret cadratin ni demi-cadratin, uniquement le tiret classique `-`
  (contrôlé par `npm run check:typo`).
