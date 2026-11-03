# ESAM Sauvegarde

Appli web de sauvegarde des médias terrain de l'ESAM (Equipe de Secours Animalier
en Montagne). En fin d'intervention, elle copie les cartes mémoire (drone, caméras,
téléphones) sur un SSD branché au téléphone, vérifie chaque copie par empreinte et
range les fichiers par intervention. Elle fonctionne dans Chrome sur Android, sans
installation, et hors réseau.

Adresse : https://julok35.github.io/esam-backup/

> **Étape 0 en cours.** Seule la page de test est disponible : elle vérifie que le
> téléphone sait lire une carte et écrire sur le SSD. L'appli de sauvegarde n'est
> pas encore utilisable.

## Développement

```sh
npm install
npm run dev
npm test
```

Avant de pousser : `npm run check` (types et typographie) et `npm run build`.

- Architecture, règles de nommage et conventions : [`CLAUDE.md`](CLAUDE.md)
- Tests manuels et fiche d'usage : [`docs/`](docs/)

## Licence

MIT, voir [`LICENSE`](LICENSE).
