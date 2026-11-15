# Le bon robot — Comparateur Belgique

**Site public : [ouvrir le comparateur](https://nvandewalle.github.io/comparateur-aspirateurs/).**

Comparateur interactif et sourcé d'aspirateurs robots laveurs pour la Belgique. La recherche de cette première publication est datée du **15 novembre 2026** : les prix sont des observations archivées, pas des prix en temps réel. L'analyse est consultable dans l'application et exportable en Markdown.

## Mise à jour automatique

Chaque push sur `main` déclenche le [workflow GitHub Pages](.github/workflows/deploy-pages.yml), y compris après une modification des données ou du modèle HTML. Il exécute le générateur et ses validations, renomme le HTML produit en `_site/index.html`, puis publie uniquement ce site généré sur GitHub Pages. Le workflow peut aussi être relancé manuellement depuis l'onglet **Actions**, sur `main`.

La publication ne lance aucune recherche de prix et ne contacte pas les sites marchands. Les données doivent être actualisées dans les sources, puis poussées sur `main`.

## Sources et génération locale

Le générateur `build.mjs` assemble `comparator.template.html`, `market-data.json`, `analysis-content.json`, `ranges-content.json`, `review-enrichment.json` et les références de `product-images.json`. Il utilise uniquement les modules natifs de **Node.js 22** : aucune installation de dépendances n'est nécessaire pour générer le site.

```powershell
node build.mjs _site
```

Ouvrir ensuite `_site\comparateur-aspirateurs.html` dans un navigateur récent. Comparaison, données et réglages fonctionnent hors ligne ; les photos nécessitent une connexion. Le répertoire `_site` est généré et n'est pas versionné.

## Photos et crédits

`product-images.json` conserve uniquement des URL HTTPS publiques officielles, la page d'origine, le titre identifiant le modèle et le crédit. Les images restent hébergées par les fabricants : aucune licence libre ou autorisation de redistribution de leurs fichiers n'est présumée, et aucune image d'une variante différente ne doit remplacer une photo manquante.

Les vignettes se chargent à la demande, sans en-tête `Referer`, avec un emplacement réservé et un état d'échec explicite. La CSP n'autorise que les hôtes d'images présents dans le catalogue. Le lien d'origine accompagne les visuels ; les crédits regroupés sont accessibles dans **Sources**. Si un fabricant retire ou bloque son image, les données restent disponibles et la photo est signalée comme indisponible.

## Contrôles de l'interface

```powershell
npm ci
npm test
```

Les contrôles utilisent Playwright avec Edge sous Windows, ou Chromium installé avec `npx playwright install chromium` sur les autres plateformes. Ils vérifient les 26 photos et nécessitent donc un accès réseau. Les dépendances de test ne sont pas requises pour le déploiement.

La comparaison garde une barre compacte de noms hors du conteneur de défilement horizontal. Cette barre reste sous l'en-tête du site pendant le scroll de la page ; ses colonnes et le tableau se synchronisent dans les deux sens. La première colonne de critères reste fixe. Les contrôles couvrent le vrai défilement de document et les gestes tactiles à 360 et 390 px, ainsi que l'ordinateur.

## Préférences et confidentialité

Les préférences et prix personnels restent dans le `localStorage` du navigateur, sous la clé compatible `robot-comparator-be-v1` (version 1), sans envoi à GitHub. Ils ne sont pas synchronisés automatiquement entre appareils.

Le site HTTPS et un ancien fichier HTML local ont des espaces de stockage distincts. Pour transférer vos réglages, utiliser l'export puis l'import des préférences dans l'application ; ne pas ajouter cet export au dépôt public.
