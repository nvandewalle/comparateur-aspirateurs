# Le bon robot — Comparateur Belgique

**Site public : [ouvrir le comparateur](https://nvandewalle.github.io/comparateur-aspirateurs/).**

Comparateur interactif et sourcé d'aspirateurs robots laveurs pour la Belgique. La recherche de cette première publication est datée du **15 novembre 2026** : les prix sont des observations archivées, pas des prix en temps réel. L'analyse est consultable dans l'application et exportable en Markdown.

## Mise à jour automatique

Chaque push sur `main` déclenche le [workflow GitHub Pages](.github/workflows/deploy-pages.yml), y compris après une modification des données ou du modèle HTML. Il exécute le générateur et ses validations, renomme le HTML produit en `_site/index.html`, puis publie uniquement ce site généré sur GitHub Pages. Le workflow peut aussi être relancé manuellement depuis l'onglet **Actions**, sur `main`.

La publication ne lance aucune recherche de prix et ne contacte pas les sites marchands. Les données doivent être actualisées dans les sources, puis poussées sur `main`.

## Sources et génération locale

Le générateur `build.mjs` assemble `comparator.template.html`, `market-data.json`, `analysis-content.json`, `ranges-content.json` et `review-enrichment.json`. Il utilise uniquement les modules natifs de **Node.js 22** : aucune installation de dépendances n'est nécessaire.

```powershell
node build.mjs _site
```

Ouvrir ensuite `_site\comparateur-aspirateurs.html` dans un navigateur récent. Le fichier est autonome et fonctionne aussi hors ligne. Le répertoire `_site` est généré et n'est pas versionné.

## Préférences et confidentialité

Les préférences et prix personnels restent dans le `localStorage` du navigateur, sous la clé compatible `robot-comparator-be-v1` (version 1), sans envoi à GitHub. Ils ne sont pas synchronisés automatiquement entre appareils.

Le site HTTPS et un ancien fichier HTML local ont des espaces de stockage distincts. Pour transférer vos réglages, utiliser l'export puis l'import des préférences dans l'application ; ne pas ajouter cet export au dépôt public.
