# Étape 0 - Tests manuels sur le S24 Ultra

Page de test : https://julok35.github.io/esam-backup/test/

But : vérifier, avant tout développement, que Chrome Android sait lire une carte
et écrire sur le SSD branchés au téléphone, mesurer les débits, voir comment
reconnaître une carte et si le téléphone se souvient des dossiers choisis.
Section 4 du brief.

**Critère d'arrêt : si l'étape 1 (lecture de la carte) échoue, ou si aucune
écriture sur le SSD ne réussit à l'étape 2, l'architecture est à revoir.** Arrêter
les tests, exporter le CSV et le signaler avant d'écrire la moindre ligne des lots
suivants.

### Lire le bandeau en haut de la page

| Bandeau | Sens | Que faire |
|---|---|---|
| Aucun | Rien de bloquant pour l'instant | Continuer les étapes |
| Rouge « L'architecture est à revoir » | Carte illisible, ou aucune écriture réussie sur le SSD | Rebrancher, rechoisir le dossier, refaire une fois ; si l'échec persiste, arrêter et envoyer le CSV |
| Orange « Écriture limitée en taille : à analyser » | De petites écritures réussissent (reprise de 1 Mo, premiers paliers) mais une plus grosse échoue. Le bandeau donne la plus grande taille réussie et la plus petite en échec | Pas d'arrêt : faire « Chercher la taille limite » (étape 2), finir les autres étapes, puis envoyer le CSV et le résumé. La suite (morceler les gros fichiers, autre méthode d'écriture) se décide sur ces mesures |

Premiers résultats (03/11, S24 Ultra, Chrome 156, SSD exFAT « 5298-D0F1 ») :
lecture de la carte OK (dossier nommé « media »), ajout de 1 Mo à un fichier OK,
écriture d'un fichier de 1 Go en échec (NoModificationAllowedError), move()
absent, accès redemandé par Chrome à chaque ouverture de la page. Piste : sur
Android, Chrome écrit d'abord dans son cache interne puis recopie le fichier vers
le SSD au close() (ticket Chromium 40101963) ; le test par paliers sert à trouver
la taille limite et la phase de l'échec.

## Prérequis

| Élément | Détail | Coché |
|---|---|---|
| Téléphone | Samsung S24 Ultra, Google Chrome à jour (version notée par la page). Pas Brave : il désactive le choix de dossier tout en se présentant comme Chrome, la page le signale | [ ] |
| Batterie | Au moins 50 %, ou chargeur branché sur le port PD du hub | [ ] |
| Hub | Hub USB-C 3.2 avec port de recharge PD | [ ] |
| Lecteur | Lexar USB-C (SD et microSD), branché sur le hub | [ ] |
| Carte | Une carte remplie par le M30T (MP4, JPG, R-JPEG, SRT, LRF), avec au moins une vidéo de plus de 1 Go | [ ] |
| Deuxième carte | Une autre carte (SanDisk par exemple), pour l'identification | [ ] |
| SSD | Formaté en exFAT, au moins 15 Go libres, branché sur le hub | [ ] |
| Réseau | Nécessaire au premier chargement de la page ; ensuite la page marche hors réseau | [ ] |

Conseils :

- Ouvrir la page une première fois avec du réseau, puis la recharger une fois :
  elle est alors en cache et fonctionne en mode avion.
- Garder l'écran allumé pendant les tests (la page le demande elle-même pendant
  les tests longs) et ne pas changer d'appli pendant une mesure.
- Unité des débits : 1 Mo = 1 048 576 octets. Les 205 Mo/s annoncés par Lexar
  (1 Mo = 1 000 000 octets) correspondent à environ 195 Mo/s sur la page.
- Chaque mesure est notée dans le journal en bas de page. Le journal survit à un
  rechargement. À la fin : « Envoyer le CSV » (mail) et « Copier le résumé ».

## Déroulé

Faire les étapes dans l'ordre. Chaque étape s'ouvre d'un appui sur son titre ;
son état (OK, Échec, Non disponible, À vérifier) s'affiche à droite du titre.

### Étape 0 - Capacités du navigateur

Gestes : ouvrir la page. Rien à faire, sauf appuyer sur « Autoriser les
notifications et tester la vibration » et accepter.

À noter : modèle et version de Chrome affichés, liste des fonctions absentes
(surtout « Renommer un dossier (move) », « Identifiant de poignée »,
« Partage de fichiers »), notification affichée et vibration ressentie.

Réussite : badge OK, pas de bandeau rouge. Un bandeau rouge « L'architecture
est à revoir » signifie que Chrome ne sait pas choisir un dossier :
**arrêt**, sauf pour mesurer la lecture avec le repli de l'étape 1.

### Étape 1 - Lecture de la carte

Gestes :

1. Brancher hub, lecteur et carte.
2. « Choisir le dossier de la carte », choisir la racine de la carte (si Chrome
   refuse, choisir DCIM), accepter l'accès. Le parcours complet se lance tout
   seul ; le journal note les 10 premières entrées du dossier choisi (pour savoir
   ce qu'est un dossier nommé « media »).
3. Lire le résultat du parcours, puis appuyer sur le bouton principal « Lire en
   entier le plus gros fichier » (ne pas l'oublier : c'est le test qui compte pour
   le verdict).

À noter : nom du dossier affiché, nombre de fichiers, volume total, extensions
(MP4, JPG, R-JPEG, SRT, LRF attendues pour le M30T), durée du parcours, débit de
lecture du plus gros fichier.

Réussite : parcours sans dossier illisible, nombre de fichiers et volume
cohérents avec la carte, plus gros fichier lu en entier (badge OK).

**Échec = arrêt** (architecture à revoir). Avant de conclure : rebrancher le
lecteur, rechoisir le dossier, réessayer une fois. Si le bouton ne marche pas du
tout, utiliser « Repli sans choix de dossier » pour au moins mesurer la lecture,
et le noter : ce repli n'est pas l'architecture cible.

### Étape 2 - Écriture sur le SSD

Gestes :

1. Brancher le SSD.
2. « Choisir le dossier du SSD » (la racine convient), accepter l'accès en
   écriture.
3. Taille 1 Go, morceaux 8 Mo : « Écrire puis relire le fichier d'essai ».
   En cas d'échec, la page dit en clair « Échec pendant la phase X, après Y Mo
   écrits en Z s » (phase : ouverture, écriture, close ou relecture) et donne le
   nom de l'exception : le noter.
4. « Chercher la taille limite » (morceaux 8 Mo). La page écrit des fichiers de
   1 Mo, 16 Mo, 64 Mo, 128 Mo, 256 Mo, 512 Mo puis 1 Go dans
   `ESAM_test_etape0/` (fichiers `palier_<taille>.bin`). Au premier échec, elle
   réessaie une fois le même palier puis s'arrête. Compter jusqu'à 15 minutes ;
   garder l'écran allumé. Au palier de 16 Mo, elle mesure aussi trois façons
   d'ouvrir un fichier neuf (keepExistingData faux, keepExistingData vrai,
   mode exclusif si Chrome le connaît). Si un palier de 256 Mo ou plus réussit,
   elle mesure le temps d'ouverture d'une reprise sur ce fichier. À la fin, les
   fichiers de palier sont supprimés, sauf le dernier en échec, laissé pour
   inspection (regarder sa taille dans l'explorateur de fichiers du téléphone).
5. Si l'écriture de 1 Go a réussi : recommencer l'étape 3 avec 4 Go (vérifie que
   le SSD est bien en exFAT : en FAT32 l'écriture échoue vers 4 Go).
6. « Tester renommage et reprise » : renommage d'un dossier, ajout de 1 Mo à un
   fichier existant, et temps d'ouverture d'une reprise sur un fichier de 256 Mo
   ou plus s'il en existe un.

À noter : débit d'écriture (jusqu'au close inclus), durée du close() à part,
débit de relecture, empreintes identiques ou non ; tableau des paliers (OK ou
échec, débit, part du close()), phase et octets écrits au premier échec, second
essai réussi ou non ; phrase sur le close() (« proportionnel à la taille » =
Chrome recopie le fichier de son cache vers le SSD au close()) ; variantes du
palier de 16 Mo ; renommage possible ou non ; temps d'ouverture de la reprise
sur un gros fichier (« recopie probable » ou « rapide »).

Réussite : fichiers de 1 Go et 4 Go écrits puis relus avec des empreintes
identiques (badge OK), tous les paliers OK. Un close() très long (plus de 20 %
du temps d'écriture) n'est pas un échec mais doit être noté : il influence la
reprise des imports.

Écriture limitée (badge orange « Écriture limitée », bandeau orange) : pas
d'arrêt. Finir les étapes 3 à 5 avec des tailles qui passent, puis envoyer le
CSV et le résumé : la plus grande taille réussie, la plus petite en échec et sa
phase décident de la suite (morceler les gros fichiers ou changer de méthode).

**Aucune écriture réussie ou empreintes différentes = arrêt** (architecture à
revoir), après un second essai avec le SSD rebranché.

### Étape 3 - Débits

Gestes : carte et SSD choisis. Pour chaque taille de morceau (1, 4, 16, 64 Mo),
mode « En parallèle », appuyer sur « Lancer les 4 mesures ». Refaire 4 Mo en mode
« L'un après l'autre ».

À noter : pour chaque taille de morceau, le débit de a (lecture seule), b
(écriture seule), c (copie sans empreinte), d (copie avec empreinte) et la
relecture de d, empreintes identiques ou non.

Réussite : les 4 mesures OK, empreintes identiques en d. Repère : la copie avec
empreinte ne devrait pas descendre très en dessous de la plus lente des mesures
a et b ; sinon, le calcul d'empreinte freine et il faudra le déplacer (lot 1).

### Étape 4 - Identification de la carte

Gestes :

1. « Analyser les poignées ».
2. Retirer la carte, la remettre, « Rechoisir la carte pour comparer » et
   choisir le même dossier.
3. Mettre la deuxième carte, « Rechoisir la carte pour comparer » et choisir sa
   racine.

À noter : le nom affiché (nom de volume du type « Lexar », numéro du type
« 1A2B-3C4D » ou nom générique), getUniqueId présent ou absent, résultat de la
comparaison avec la même carte puis avec l'autre carte, liste des 10 fichiers
les plus anciens.

Réussite : la même carte est reconnue (« oui ») et l'autre non (« non »), ou à
défaut l'empreinte des fichiers les plus anciens est différente entre les deux
cartes. Pas de critère d'arrêt : cette étape décide de la méthode
d'identification du lot 2.

### Étape 5 - Persistance des poignées

Les poignées sont enregistrées dès le choix des dossiers aux étapes 1 et 2. Pour
chaque scénario : choisir le scénario dans la liste, suivre la consigne affichée,
puis « Vérifier maintenant ». Si Chrome redemande l'accès, accepter et le noter.

Scénarios, dans l'ordre :

1. Débrancher et rebrancher la carte.
2. Débrancher et rebrancher le SSD.
3. Recharger la page : avant d'appuyer sur un bouton, noter l'état affiché tout
   seul en haut de l'étape 5. « À vérifier » (autorisation prompt) est normal :
   Chrome demande une confirmation à chaque ouverture, appuyer sur « Vérifier
   maintenant » et accepter. Seul « inutilisable » après cet appui est un échec.
4. Fermer Chrome et le rouvrir : même chose.
5. Redémarrer le téléphone (facultatif).

À noter : pour chaque scénario, carte et SSD utilisables ou non, autorisation
avant et après (granted, prompt, denied), Chrome a-t-il affiché une demande.

Réussite : les poignées restent utilisables, au pire après une demande
d'autorisation acceptée d'un appui. Si une poignée devient inutilisable après
rebranchement, ce n'est pas un arrêt : il faudra rechoisir le dossier à chaque
import (à noter, cela change l'écran d'accueil du lot 1).

### Fin des tests

1. Étape 2 : « Supprimer ESAM_test_etape0 » (seul dossier que la page écrit et
   supprime).
2. Journal : « Envoyer le CSV » (mail vers soi), puis « Copier le résumé » et le
   coller dans le même mail.
3. Ranger le CSV et les conclusions dans le dépôt (`docs/`, voir le README).

## Grille de résultats

Date : ............ Chrome : ............ Version de la page : ............

Carte (marque, taille) : ............ SSD (modèle, système de fichiers) : ............

| Étape | Test | Résultat (OK / échec / non dispo) | Valeur mesurée | Remarque |
|---|---|---|---|---|
| 0 | Bandeau rouge absent | | | |
| 0 | Fonctions absentes | | | |
| 0 | Notification et vibration | | | |
| 1 | Choix du dossier de la carte | | nom : | |
| 1 | Parcours | | fichiers : volume : durée : | |
| 1 | Extensions M30T trouvées | | | |
| 1 | Lecture du plus gros fichier | | Mo/s : | |
| 2 | Choix du dossier du SSD | | nom : | |
| 2 | Écriture 1 Go | | Mo/s : close : phase de l'échec : | |
| 2 | Taille limite (paliers) | | plus grande réussie : plus petite en échec : | |
| 2 | Part du close(), proportionnel ou non | | | |
| 2 | Variantes 16 Mo (neuf, keep, exclusif) | | | |
| 2 | Relecture 1 Go, empreintes | | Mo/s : | |
| 2 | Écriture et relecture 4 Go (exFAT) | | Mo/s : | |
| 2 | Renommage d'un dossier (move) | | | |
| 2 | Reprise (keepExistingData) 1 Mo | | ouverture : | |
| 2 | Reprise sur fichier de 256 Mo ou plus | | ouverture : | |
| 3 | Morceau 1 Mo : a / b / c / d | | | |
| 3 | Morceau 4 Mo : a / b / c / d | | | |
| 3 | Morceau 16 Mo : a / b / c / d | | | |
| 3 | Morceau 64 Mo : a / b / c / d | | | |
| 3 | Morceau 4 Mo, l'un après l'autre : c / d | | | |
| 4 | Nom de la poignée de la carte | | nature : | |
| 4 | getUniqueId | | | |
| 4 | Même carte reconnue | | | |
| 4 | Autre carte distinguée | | | |
| 5 | Carte débranchée puis rebranchée | | avant / après : | |
| 5 | SSD débranché puis rebranché | | avant / après : | |
| 5 | Page rechargée (état sans action) | | | |
| 5 | Chrome fermé puis rouvert | | | |
| 5 | Téléphone redémarré | | | |
| - | Page utilisable en mode avion | | | |

Conclusion (architecture validée ou à revoir, méthode d'identification retenue,
taille de morceau retenue, comportement des poignées) :

......................................................................

......................................................................
