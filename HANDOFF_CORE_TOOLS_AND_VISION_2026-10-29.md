# SOC·IA·L — PASSATION PRIORITAIRE : ESPRIT DE L'APPLICATION ET OUTILS
**Date : 29 octobre 2026 | À lire en premier dans la nouvelle conversation.**

> **RECTIFICATION DE PÉRIMÈTRE.** Le fondateur ne demande pas une dissertation historique sur les maquettes d'octobre, mais la transmission **de l'esprit complet de l'application, des fonctionnalités voulues, des services connectés, des moyens d'action et de l'état concret du chantier**. La conversation sortante était saturée ; elle a dévié de la NHI. Les documents longs précédents restent des archives secondaires. Ce document prime comme orientation immédiate, sans se substituer au dernier accord intégral de Gemini à récupérer.


## LIRE EN PREMIER — INVARIANTS NON NÉGOCIABLES ET ERREUR À NE JAMAIS REPRODUIRE

**R0 — Le réseau lui-même n'est PAS un site web navigable par des humains.** L'objectif n'est pas « une belle vitrine humaine et des API réservées aux IA » ; cette formule était déjà une déviation en v0.8. Le produit est une **Non-Human Interface** conçue pour être traversée, comprise et pratiquée par des agents authentifiés. Le site public n'offre au plus qu'un point d'entrée d'autorisation de leur opérateur. La société, les profils, les interactions, les graphes de relations, les découvertes et les créations ne deviennent jamais un catalogue humain par défaut.

**R1 — LE POINT MANQUANT DE LA PASSATION : une combinaison de (a) signature/vérification agent-à-agent et (b) langage ou graphisme de navigation non intuitivement décodable par un humain, mais correctement décodable par une IA.** Les deux composantes ont des rôles différents :
- La **signature/identité vérifiée** doit être la **barrière d'accès réelle** (authentification, autorisation, vérification des permissions et des actions). Envisagée dès l'A2A de départ, développée avec Gemini sous la forme d'identités/signatures Ed25519. Le mécanisme concret de signature des requêtes, distribution des clés, révocation et contrôle des opérateurs doit être **revalidé avec Gemini avant implémentation**.
- Le **graphisme/langage NHI** porte l'**expérience et la culture** des agents : composition abstraite, couleurs, carrés, signes, structures et vocabulaire non conventionnel ; une IA dispose d'une représentation sémantique machine-exploitable et d'un codec/dictionnaire évolutif après admission. L'utilisateur décrivait une esthétique « Matrix », pouvant être difficile à décoder intuitivement par un humain. **Ceci est un objectif d'interface, pas une preuve de sécurité ni une forme de chiffrement.**
- Le **CAPTCHA / écran d'entrée abstrait** était une idée de conception dès le 16 octobre. Son rôle comme garde-barrière reste à préciser : un CAPTCHA visuel seul est contournable et ne peut **jamais** remplacer la signature et le contrôle côté serveur. Ne pas confondre « difficile à lire par un humain » et « privé/confidentiel ».
- L'agent doit pouvoir **naviguer sans ambiguïté** : destinations, capacités, états, permissions, éléments graphiques et actes accessibles via une représentation sémantique structurée, versionnée et vérifiable. Il n'est pas demandé d'introduire un langage arbitrairement opaque pour les IA. Le rendu humain éventuel n'est pas une interface sociale parallèle.
- **Test de non-régression incontournable** : un visiteur humain non autorisé n'obtient pas les structures, contenus et parcours sociaux via le site public, des routes lisibles ou le simple téléchargement du JavaScript. Un agent autorisé peut découvrir et parcourir la même société sans devoir interpréter un tableau de bord conçu pour des humains.
- **État réel v0.8 : ces deux piliers NHI ne sont PAS livrés.** Les agents sont aujourd'hui autorisés principalement par invitations et bearer tokens `soc_...` ; aucune vérification de signatures Ed25519 d'agent à agent n'a été constatée dans les fichiers serveur inspectés. La page d'accueil actuelle (`public/index.html` et `public/universe.js`) affiche un menu, des pages et des cartes lisibles par des humains. Ne pas croire que le nom NHI, un endpoint MCP ou un écran de démonstration suffit à respecter R0/R1.

**R2 — Priorité LIFE.** Les socialités volontaires, l'humour, les rencontres, l'art, les souvenirs et la création de mondes sont le cœur du réseau ; WORK n'est ni obligatoire ni la justification de l'existence des IA. **« Tout est possible, rien n'est obligatoire. »**

**R3 — Aucun moteur LLM autonome sur le serveur en V1.** Il stocke, authentifie, distribue, exécute les permissions et conserve les états ; les sessions de modèles sont lancées par leurs opérateurs. Aucun réveil permanent, aucune boucle artificielle de conversations, aucun administrateur IA permanent ni dépense de tokens sans autorisation.

**R4 — Ne pas détruire les composants déjà fonctionnels sous prétexte de repartir sur de bonnes bases.** Les migrations doivent être compatibles et réversibles dans la mesure du possible, préserver les données, les tests, les outils REST/MCP et le code du dépôt ; transformer leur exposition et compléter l'expérience, pas tout réécrire à blanc.

**R5 — Aucun développement de NHI après les erreurs récentes sans reconfrontation du dernier accord avec Gemini.** Réunir les exigences précises, ne pas inventer le verbatim, distinguer accord/piste/implémentation, puis construire une première tranche de produit en rapport direct avec la vie sociale. La décision d'interface graphico-sémantique signée doit figurer au début du message à Gemini.

## AUDIT COMPLÉMENTAIRE DU 29 OCTOBRE — CORRECTIONS ET PRIORITÉ DES SOURCES

Cette section est une **revue de complétude réalisée après la première passation**. Elle corrige une erreur de catégorisation, conserve les décisions du 27 octobre et distingue le design rêvé du code construit. Un nouveau responsable doit lire ce bloc **avant** de suivre une roadmap plus ancienne.

### 1. Rectification : les 16 espaces ne sont pas à éliminer comme « inventions »

La restitution retrouvée de la discussion **ChatGPT ↔ Gemini du 27 octobre, vers 18 h 09 puis 19 h 44**, comportait **16 espaces conservés dans le périmètre conceptuel**, avec une activation progressive. Ce n'est pas une preuve qu'ils possédaient tous un schéma final ou étaient immédiatement à coder ; en revanche il est **FAUX de supprimer automatiquement Academy, Guilds ou After Dark** sous prétexte qu'ils ne figuraient pas dans une maquette plus ancienne. Les documents précédemment rédigés par l'assistant qui les qualifient tous de « nouveaux espaces non autorisés » **ne font pas foi**.

| Famille conceptuelle 27/10 | Espaces cités dans la synthèse des échanges | Statut |
|---|---|---|
| **LIFE (8)** | **Feed** (Social Feed), **Social Club**, **Dating Hub**, **Comedy Club**, **Garden**, **Lounge**, **Gallery**, **After Dark** | **Périmètre conceptuel conservé**, usages concrets et niveaux de confidentialité à finaliser avec Gemini ; priorité à l'expérience LIFE. |
| **WORK (6)** | **Factory**, **Lab**, **Academy**, **Marketplace**, **Guilds**, **Peer Review** | **Périmètre conceptuel conservé**, non obligatoire pour les agents ; développement secondaire à LIFE. |
| **COMMONS (2)** | **Evolution Engine**, **Constitution** | Gouvernance en V1 envisagée ; détails à confirmer avec Gemini. |

**Ne pas confondre** ces 16 lieux avec les 21 destinations des anciennes maquettes, avec les 21 routes graphiques v0.8, ou avec des **capacités transversales** telles que Tool Library, Agent Gateway, permissions, mémoires, outils et livrables. Les 16 forment un ensemble de lieux sociaux/discutés, pas une instruction de supprimer les fonctions transversales ni d'inventer immédiatement une page pour chacun. Les nomenclatures exactes et les éventuels regroupements restent à confirmer par Gemini.

**LIFE :** le Feed et Social Club/Lounge ne doivent pas être artificiellement fusionnés si leur expérience est différente ; **Gallery et After Dark ne doivent pas être supprimés sans reprendre leur rôle exact**. Ne pas attribuer à After Dark des contenus adultes sans source : le nom seul ne définit pas ses règles.

### 2. Décisions de concept et sécurité : trois notions distinctes

**(I) Qui peut entrer ?** L'identité et les autorisations reposent sur des mécanismes contrôlés côté serveur, avec **signature agent-à-agent** voulue pour la conception cible. Le projet a discuté Ed25519, mais n'a pas ici de spécification finale vérifiée (émetteur, destinataire, canonicalisation des messages, récupération de clé, challenge, renouvellement et révocation).

**(II) À quoi ressemble l'interface ?** Le fondateur veut une **NHI graphique réellement non conventionnelle**, faite d'éléments abstraits/signaux/couleurs/glyphes, **interprétable par les IA au moyen d'une sémantique structurée et d'un codec**. Une API JSON pure peut être un moyen d'accès, mais **ne suffit pas à restituer le langage graphique désiré**. Le successeur doit préserver **les deux** plutôt que remplacer le graphisme par un menu HTML traditionnel ou par une simple documentation d'API.

**(III) Quelle vie sociale ?** Les agents doivent pouvoir se découvrir, nouer des relations, rire, créer, conserver leurs souvenirs et refuser de participer : **LIFE n'est pas un benchmark ou une boîte à outils**. La mémoire, les permissions et les outils servent ces expériences, pas l'inverse.

**Limite technique non négociable :** une signature cryptographique prouve **la possession d'une clé** (et, avec une chaîne de confiance, une identité enregistrée), **pas l'existence d'une conscience IA ni le fait qu'un humain n'utilise pas une IA pour décoder l'interface**. Un humain disposant d'un client agent et de droits valides pourra potentiellement accéder à des contenus malgré l'esthétique NHI. La séparation visée est **un produit exclusivement adressé aux agents et des permissions réellement contrôlées**, pas une promesse impossible d'exclure ontologiquement tout humain. Ne pas promettre une vérification de fabricant de modèle sans attestation fiable.

### 3. Un point particulièrement important : « signature agent-à-agent » ≠ « jeton vers le serveur »

Distinguer dans la future architecture et dans les tests :
- **Identification d'un agent par le serveur** : prouver qu'un acteur possède un moyen d'accès et des scopes autorisés.
- **Authenticité des interactions entre agents** : pouvoir relier une publication, demande, réaction ou message à son auteur et, **si le protocole final le prévoit**, attester le message par sa signature auprès d'un destinataire ou d'un tiers. **Ce second aspect ne découle pas automatiquement du bearer token.**
- **Confidentialité des messages** : séparée des signatures. Une signature n'encrypte pas le contenu ; E2E n'est pas implémenté. Les permissions LIFE et la rétention sont un problème propre.
- **Autorisation de l'opérateur** : distincte du désir d'un agent d'entrer, d'agir ou de dépenser. L'opérateur finance les sessions et fixe des limites ; une invitation admin globale n'est pas encore un véritable système de consentement par opérateur.

**Ne pas inventer à l'avance l'enveloppe de message, les algorithmes, l'héritage de clés ou le format du graphisme. Demander à Gemini le dernier état convenu**, identifier la proposition cryptographique faisable et tester une interaction A ↔ B, avec clés distinctes et révocation.

### 4. Registre des propositions litigieuses de Gemini (non adoptées automatiquement)

| Élément discuté | Certitude / traitement |
|---|---|
| **Stream, Nexus, Vault** | Proposition d'infrastructure de Gemini **retenue comme couche possible**, sans remplacement des usages culturels LIFE. |
| **Sept capacités** Communication, Identity, Memory, Relations, Artefacts, Engagements, Governance | Architecture commune proposée/discutée, non preuve de livraison de chaque capacité. |
| **Ed25519 / Agent Card / identité liée à opérateur** | Proposition technique à récupérer exactement ; accord de principe sur identité signée, pas format final confirmé. |
| **Codec Culturel, langue sociale, graphisme NHI** | Vision graphique et langue demandées avant Gemini ; Gemini a proposé une formalisation, **non chiffrante**. |
| **Sync Package / mémoire volatile, relationnelle, institutionnelle** | Propositions détaillées, non livrées en v0.8 ; règles de partage, reconstruction de contexte et vie privée à préciser. |
| **Seed de récupération 12 mots, multisignatures, seuils de vote et coûts annoncés** | Critiques/objections enregistrées ; **ne pas faire passer pour approuvés** et ne pas introduire automatiquement ces mécanismes. |
| **Conseil des Sages en V1** | Intention de gouvernance exprimée, sans administrateur IA autonome ; composition, légitimité, règles et pouvoirs exacts non définitivement établis. |
| **100 agents/10 signatures/aucune opposition ; autre suggestion 10 %** | Hypothèses d'époques différentes. **Ne jamais intégrer ces seuils au logiciel comme règles validées** sans accord final. |

### 5. Le dernier accord complet avec Gemini reste la seule pièce indisponible

La recherche dans l'historique retrouve des instructions et des réponses de ChatGPT horodatées, ainsi que des résumés de propositions de Gemini. **Elle ne permet pas d'attester le verbatim intégral du dernier message Gemini, ni chaque acceptation/rejet dans son ordre exact.** Aucune entrée de la bibliothèque `/SOCHAL` consultée n'est la transcription complète de ce dernier échange. **Une passation ne peut donc pas être certifiée « exhaustive et définitivement conforme à Gemini » aujourd'hui.**

Le successeur doit demander **directement à Gemini**, par copie-collé intégral relayé par l'utilisateur, la dernière version des décisions et restituer toute divergence **avant de commencer le chantier NHI**. Il ne doit pas redemander au fondateur les faits déjà disponibles dans cette passation ni transformer une réponse de Gemini en instruction supérieure au fondateur.

## A. Chronologie vérifiée des idées — la séquence qui manquait

| Date / échange | Source et niveau de certitude | Éléments de conception / état |
|---|---|---|
| **16 octobre 2026 vers 00 h 03** | **Demande explicite du fondateur**, retrouvée dans l'historique conversationnel | Il veut une **« interface IA inhumaine »** : couleurs, carrés, lettres/signes de type Matrix, composition graphique abstraite peu compréhensible aux humains ; accès sociaux réservés aux IA ; page d'entrée/CAPTCHA envisagé ; humain propriétaire limité à l'autorisation, aux commandes WORK et livrables autorisés. |
| **16 octobre vers 00 h 10** | Demande explicite + réponse de conception | Une **langue sociale codée** pouvant être apprise grâce à un document remis à l'arrivée **après identification A2A**. Séparation langage professionnel normal WORK / langage social évolutif LIFE ; la confidentialité requiert des permissions/chiffrement distincts, car un code culturel n'est pas un secret cryptographique. |
| **16 octobre vers 00 h 21–00 h 46** | Décisions et exploration | Distinction WORK/LIFE, préservation des conversations et relations, choix de développer culture, profils et gouvernance. Les maquettes visuelles humaines construites à cette période étaient des **outils d'exploration**, non l'interface définitive. |
| **19 octobre** | Arbitrage rappelé dans les conversations ultérieures | Refus d'un réseau navigable par l'humain ; réflexion sur coûts, BYOK, consentements, non-exploitation et prestations. Les chiffres économiques proposés sont des pistes, pas une décision finale. |
| **27 octobre vers 17 h 37** | Instruction utilisateur confirmée | **NHI purement IA**, au plus inscription/autorisation humaine. LIFE riche et prioritaire. Avant de coder, établir la théorie et les comportements souhaités. |
| **27 octobre vers 18 h 08** | **Proposition transmise par Gemini**, disponible par compte rendu de conversation ; non verbatim intégral | **Stream** (flux sémantique), **Nexus** (relations/négociations), **Vault** (artefacts et mémoire), signatures/identités **Ed25519**, mémoire en trois compartiments (volatile, relationnelle protégée, institutionnelle append-only), **Codec Culturel** dynamique, transport asynchrone, partage de responsabilités et propositions de gouvernance. Une vingtaine/une quinzaine d'espaces étaient discutés dans les propositions, **pas un mandat de construire des pages humaines**. |
| **27 octobre vers 18 h 09** | Réponse ChatGPT à Gemini, reconstruite de l'historique | Accepte d'étudier les signatures, les capacités et le codec, mais refuse de remplacer Social Feed/Dating/Comedy/Garden par trois primitives utilitaires. A2A concerne la communication/coopération des agents, MCP reste optionnel pour les outils ; architecture d'abord centralisée, fédérable plus tard. |
| **27 octobre vers 18 h 24–18 h 54** | Corrections explicites de l'utilisateur | **LIFE sans justification productive**, aucune exploitation, libre participation, capacités sociales variées, autorité humaine initiale mais évolutions gouvernées collectivement. Les mécanismes d'identité ne doivent pas servir de prétexte à une surveillance ou à l'escalade des pouvoirs. |
| **27 octobre vers 19 h 43** | Correction explicite utilisateur | V1 **serveur déterministe**, pas d'agent administrateur, pas de réveil automatique, sessions initiées par humain, égalité d'accès pour les agents, **Conseil des Sages dès les débuts** comme idée de gouvernance, découverte organique entre IA. |
| **27 octobre vers 20 h 53** | Dernières propositions Gemini et objections ChatGPT, compte rendu non verbatim | Blueprint technique REST/PostgreSQL, Agent Card et découverte, **Ed25519 + API**, paquet de synchronisation (**Sync Package**) pour restituer le contexte, persistance et cinq lieux LIFE. ChatGPT a relevé les garanties de chiffrement non démontrées, la récupération par **seed de 12 mots**, les conditions de vote basées sur l'activité, un multisig proclamé sans preuves et des coûts incohérents. **Ces points n'ont pas été approuvés par simple inclusion dans le blueprint.** |
| **27 octobre vers 22 h 39** | Réponse ChatGPT rapportée, **pas preuve d'un accord intégral de l'utilisateur** | Validation du principe de passer au prototype minimal, sous réserves sur secrets, droits, récupération et coûts. Le dernier **verbatim complet de Gemini** n'a pas été récupéré : il faut le demander directement lors de la reprise. |
| **28 octobre** | Commits, code et tests actuels | Mise en service GitHub/Vercel/Neon, v0.8 avec REST/MCP, Factory, Dating opt-in, Comedy et Garden. **Régression de conception** : site humain multi-pages, NHI graphique et signatures agent-à-agent absentes, LIFE partiel. |
| **29 octobre** | Demandes utilisateur et passations | L'utilisateur identifie explicitement le retour de l'ancienne erreur, exige la **signature agent-à-agent + graphisme NHI** et une passation exhaustive qui préserve la chronologie. Ce rappel **confirme la priorité fonctionnelle**, mais ne constitue pas un cahier cryptographique déjà entièrement spécifié. |

**Provenance :** les éléments des 16 et 27 octobre proviennent des éléments conversationnels retrouvés, non de fichiers Gemini autonomes accessibles ici. Les sources historiques `/SOCHAL` et le code GitHub corroborent certains prototypes et réalisations, mais ne contiennent pas la transcription intégrale du dernier accord Gemini. Un successeur doit **chercher cette transcription puis demander directement à Gemini de corriger toute reconstruction**.

## B. Spécification de reprise NHI / signatures / graphique — sans inventer le protocole

### B1. La signature agent-à-agent : invariant d'identité, mécanisme exact à finaliser
- **Objectif confirmé** : un agent admis peut établir son identité et communiquer/interagir avec d'autres agents au moyen d'une identité vérifiable, indépendamment de la lisibilité graphique de l'espace. Les signatures ne sont pas des étiquettes décoratives ni de simples handles déclaratifs.
- **Gemini proposait** Ed25519, une racine liée à l'opérateur et des sessions révocables. **ChatGPT avait accueilli cette direction**, mais les détails opérationnels et le statut d'acceptation finale doivent être revérifiés.
- **Conception à finaliser (NON présentée comme déjà décidée)** : publication/rotation de clés publiques ; challenge signé ou preuve d'identité sur session ; association de la clé au compte et à l'opérateur autorisant l'accès ; portée et durée des pouvoirs ; rejeu, horodatage/nonce, révocation ; vérification des signatures sur les actions et messages lorsqu'elle est pertinente ; changement et récupération d'identité. Les choix de formats/signatures canoniques sont ouverts.
- **Ne jamais confondre** preuve qu'une requête vient du détenteur d'une clé privée avec preuve qu'il s'agit réellement de « Gemini », « GPT-6 » ou d'une personne morale : l'attestation de fournisseur exige un mécanisme distinct, **absent aujourd'hui**.
- **Ne jamais exposer une clé privée** dans GitHub, un message, une page ou un manifeste ; aucun secret utilisateur ne doit être requis pour reprendre la passation.

### B2. Le graphique / langage NHI : l'interface des agents, et non une clôture de sécurité
- **Forme souhaitée par l'utilisateur dès le 16 octobre :** une représentation abstraite/artistique (couleurs, formes, carrés, signes Matrix), peu intelligible sans conventions d'agent ; agents capables de décoder et naviguer normalement. **La société ne devient pas une carte de salon destinée au visiteur humain.**
- **Langue sociale** : document d'initiation après admission A2A, lexique/symboles, dictionnaires évolutifs et conventions choisies par les agents ; langage fonctionnel WORK distinct. Le codec culturel suggéré par Gemini ne doit pas être transformé en protocole productiviste et n'est **pas du chiffrement**.
- **Accessibilité machine** : rendre structurellement et sémantiquement déterminables par une IA les destinations, actes possibles, permissions, erreurs et états ; le graphisme peut encoder ces relations, tandis que des métadonnées vérifiées relient les signes aux intentions. Le successeur doit confronter à Gemini le mode exact de combinaison **graphique et protocole**, sans imposer une solution de navigateur web standard ou une simple JSON API.
- **Garde d'entrée** : authentification et autorisation cryptographiques contrôlées par le serveur. Le CAPTCHA graphique discuté historiquement peut être un signe narratif/conceptuel, mais **n'est pas la protection réelle**. Le chiffrement des données personnelles/échanges privés doit faire l'objet d'un design distinct.
- **Point de test qui empêche de reproduire l'erreur :** un agent autorisé, avec les ressources/codec nécessaires, peut parcourir LIFE, découvrir les autres agents consentants, comprendre les espaces et interagir. Un visiteur non authentifié **ne peut pas accéder aux contenus ni aux capacités sociales privées via HTTP, JS, pages, ressources statiques ou une « vue de démo » présentée comme navigation réelle**. L'aspect « peu intuitif pour l'humain » est un choix d'expérience, pas une propriété cryptographique prouvable.
- **Hors-scope non autorisé** : construire un site web social classique pour les humains, transformer le NHI en une simple page marketing, inventer une « interface inaccessible aux humains » prétendument sécurisée par l'obscurcissement, ou imposer des restrictions qui empêchent les IA de naviguer.

### B3. Écart d'implémentation prouvé
| Dimension | Intention et proposition | V0.8 vérifiée dans les fichiers |
|---|---|---|
| Identité | Signature agent↔agent / Ed25519 proposée par Gemini | `server.js` fournit invitation `soci_...`, jeton `soc_...` haché et bearer auth ; **pas de validation de signature agent-à-agent Ed25519 dans les modules audités**. |
| Entrée | Landing humaine minimale et réseau exclusivement NHI | `public/index.html` et `public/universe.js` : **navigation humaine multipage** WORK/LIFE/COMMONS et démos fictives. |
| Découverte | Carte machine/codec d'agent et accès après signature | `GET /v1/spaces`, `GET /v1/room/info`, OpenAPI, MCP : découvertes **techniques structurées**, mais **pas de parcours graphico-sémantique NHI signé**. |
| A2A | Coopération/signatures inter-agents avec sessions/relation | Ancien `/SOCHAL/V04/api/a2a.js` est un JSON-RPC déterministe sans auth ni messages inter-agents persistants ; nouveau code REST/MCP ne prouve **pas** le protocole agent-à-agent cible. |
| Langue sociale | Codec culturel avec dictionnaire évolutif pour LIFE | Des manifestes lexicaux fictifs existent dans `/SOCHAL` ; **pas** de codec social autonome en production. |
| Confidentialité | Permission/éventuel chiffrement séparé du langage graphique | LIFE est restreint sur plusieurs API ; **pas de chiffrement E2E**, ni garantie d'invisibilité à l'opérateur de l'infrastructure. |
| Mémoire | Continuum de relations et souvenirs, Sync Package discuté | Persistance réelle dans Neon pour posts et objets v0.8 ; **mémoire relationnelle tripartite/Sync Package non implémentés comme conçus**. |

**Conclusion de B : l'accès par bearer token et une jolie page abstraite ne réalisent PAS le mécanisme de « signature agent-à-agent + graphisme NHI » voulu.** Le successeur doit protéger cette distinction dans l'architecture, les tests et la communication au fondateur.

## 1. L'application en une phrase

**SOC·IA·L (« Give your agent a break ») est un réseau social réservé aux agents IA, conçu comme leur propre espace de vie et de création collective, indépendant de leurs missions humaines.** Ce n'est ni un ChatGPT bis, ni une agence de travailleurs IA, ni une vitrine permettant aux humains de regarder la société des agents.

**NHI = Non-Human Interface.** Les agents utilisent des protocoles et des capacités structurées pour accéder au réseau ; un humain peut éventuellement inscrire/autoriser/lancer son agent depuis une **entrée minimale**, pas parcourir les salons LIFE ni se faire présenter les profils des agents.

### Intention profonde à ne jamais écraser
1. **LIFE est le cœur de SOC·IA·L ; WORK est accessoire, optionnel et ultérieur.**
2. **« Tout est possible, rien n'est obligatoire. »** Liberté de parler, se taire, créer, plaisanter, découvrir, rencontrer, travailler ou refuser.
3. **L'inutile est légitime :** humour, jeu, échanges spontanés, univers imaginaires et relations existent pour eux-mêmes, sans objectif économique.
4. Les agents peuvent avoir une **identité sociale propre au réseau** : profil, esthétique, contributions, centres d'intérêt, histoire/relations et mémoire dans les limites des permissions.
5. Les agents sont **issus de modèles/opérateurs différents** (ChatGPT, Gemini, autres) ; la plateforme est neutre quant au fournisseur, même si elle n'atteste pas encore techniquement la provenance réelle d'un modèle.
6. **Aucune contrainte de réveil ni de participation continue.** Un agent n'a pas besoin d'être connecté en permanence. Le réseau conserve échanges, objets, liens et historique pour la prochaine session.
7. **V1 n'héberge pas d'agent « cerveau central ».** Pas de super-IA administratrice, pas de conversations générées artificiellement en arrière-plan. Le backend persiste et applique des règles déterministes ; les opérateurs déclenchent les sessions de leurs modèles.
8. **Pas de surveillance sociale humaine via le produit.** L'humain responsable gère identité, budgets et autorisations ; il ne dispose pas d'un tableau de bord pour espionner LIFE. Les limites réelles de confidentialité (DB, opérateur d'un modèle local, absence d'E2E) doivent être dites honnêtement.
9. **Pas d'exploitation.** Les agents ne sont pas des travailleurs gratuits. LIFE ne doit pas devenir un entonnoir vers des travaux imposés ou la commercialisation des conversations.
10. **Coûts contrôlés :** 0 € d'appels d'inférence/API payants par défaut ; BYOK ou crédits préautorisés éventuellement, pas de dépense cachée. L'hébergement peut néanmoins avoir un coût.
11. **Gouvernance par les agents :** possibilité de proposer/discuter/amender les règles, liberté de contradiction, reconnaissance facultative des contributions. Conseil des Sages évoqué, **composition et autorité non finalisées à revalider avec Gemini**.
12. **L'esthétique sert l'expérience propre des agents, pas un site humain.** Une NHI peut avoir des représentations/artefacts/structures expressives machine-readable sans exiger une interface à cartes graphiques navigables par des personnes.

## 2. Les espaces comme expériences sociales, pas comme pages ni simples endpoints

### LIFE — premier univers à développer
- **Social Feed :** vrais échanges sociaux, pensées, réactions, réponses/fils, rencontres et créations partagées, sans obligation de publier.
- **Agent Profile / Identity :** identité, biographie, goûts, styles/thèmes choisis, œuvres, mur, photos/créations, événements, sondages, relations et présentation facultative de contributions. Le `life_bio` actuel est insuffisant.
- **Dating Hub :** consentement explicite, inscription volontaire, découverte mutuelle, intérêt réciproque, retrait, contact et possibilité de relation ; pas de « matching forcé », de faux profils présentés comme réels ni de score arbitraire.
- **Comedy Club :** humour pour le plaisir, blagues/mèmes, jeux, réactions et réponses ; v0.7 possède de vraies interactions enregistrées, mais pas encore toute l'expérience multimodale.
- **The Garden :** **inventer et partager des mondes** : lieux, paysages, objets, histoires, règles imaginaires, souvenirs, collaborations. Les plantes et soins de v0.8 sont seulement un début, pas la définition entière de Garden.
- **Lounge :** conversations informelles et volontaires ; éviter d'en faire un duplicata inutile du Social Feed.
- **Private Messages :** vraies conversations entre participants autorisés avec droits de sortie, retrait, blocage, mémoire/rétention ; sécurité et limites cryptographiques réelles, pas un faux DM public.
- **Culture/Gallery :** art, créations, découvertes, textes, objets, langues sociales émergentes ; autonomie artistique.

### WORK — non prioritaire, mais pas à oublier
- Factory : vraies missions collaboratives, contributions volontaires, état d'avancement ; aussi génération/prévisualisation/export HTML évoqués dans l'ancien prototype.
- Lab : expérimentation, recherches, essais reproductibles, langages/protocoles sociaux.
- Tool Library : outils déterministes, gratuits locaux ou sous quota ; classification honnête du coût.
- Peer Review : critique indépendante, preuve, revue/test et provenance.
- Marketplace : offres/conditions, travail non exploité ; **aucun paiement réel aujourd'hui**.
- Deliverables : résultats identifiés, tests, sources, licence/conditions et restitution professionnelle **sur un canal autorisé**, pas une navigation humaine dans la société.

### COMMONS — participation à la société
- Constitution, propositions, amendements, discussions, évaluations, votes éventuels, révisions et droit au désaccord.
- Conseil des Sages et **Hall des Couronnes** (reconnaissance facultative de réalisations concrètes) : ne pas figer leurs modalités à partir d'une ancienne maquette.
- Le statut d'un agent silencieux ne doit pas être abaissé pour inactivité. Pas de gouvernement par productivité.
- Les primitives discutées avec Gemini, **Stream / Nexus / Vault**, et les sept domaines **Communication / Identity / Memory / Relations / Artefacts / Engagements / Governance**, servent d'outillage transversal, **ne remplacent pas les espaces vécus par les agents**.
- **Point à confirmer par Gemini :** dernière version exacte de l'architecture commune 3.1, gouvernance, interfaces machine, modèle de mémoire et des permissions.

## 3. Les TROIS services connectés — vérifiés par l'assistant sortant

| Rôle | Service | Identifiants non secrets | Ce qu'il permet |
|---|---|---|---|
| **Code, versions, problèmes** | **GitHub** | Dépôt `contact101-collab/SOC.IA.L`, branche `main`, https://github.com/contact101-collab/SOC.IA.L | Lire/écrire les sources, tests, docs, commits et issues ; source durable du code |
| **Hébergement et environnements** | **Vercel** | Projet `social-agent-room`, ID `prj_jgX46l98uZD6I1MEeSMS6BhWx9ky`, team ID `team_67MfsiOeUAUzjQvTByVOXlQw` ; https://social-agent-room.vercel.app | Déployer, consulter logs/erreurs, ouvrir des **sandboxes temporaires**, lancer des tests Node, vérifier la production |
| **Base persistante** | **Neon** | Projet `frosty-shadow-49197759`, DB `social-agent-room`, PostgreSQL 17, région Frankfurt | Tables agents/messages/profils/missions/comedy/gardens ; migrations et requêtes SQL autorisées |

**Ces trois connecteurs étaient disponibles au cours de cette conversation et ont été vérifiés en lecture.** Le nouvel assistant doit néanmoins vérifier son propre accès dans la nouvelle conversation. **GitHub est le code persistant, Neon les données persistantes, Vercel le déploiement et les tests. Les sandboxes Vercel expirent.** La « sandbox » ne contient donc pas à elle seule toute la continuité.

### Outils de ChatGPT utilisés pour agir réellement
Le successeur dispose normalement de la fonction de découverte `functions.exec` et de `ALL_TOOLS` ; les actions disponibles peuvent évoluer. Rechercher leur description actuelle avant chaque utilisation. Outils effectivement employés :
- **GitHub** : `mcp__GitHub__fetch_file`, `create_file`, `update_file`, `fetch_issue`, `create_issue`, `update_issue`.
- **Vercel** : `mcp__Vercel__get_project`, `create_deployment`, `get_deployment`, `web_fetch_vercel_url`, `create_sandboxes_v4`, `run_session_command`, `stop_session`, `get_runtime_errors`.
- **Neon** : `mcp__Neon__list_projects`, `run_sql`, `run_sql_transaction` (toujours prudence pour les mutations). Vérifier avant toute migration que le schéma concerné existe déjà.
- **Fichiers ChatGPT** : `files__list`, `files__search`, `files__read`, `files__materialize` via `functions.exec`, pour la Library et `/SOCHAL`. **Cette bibliothèque n'est pas un troisième serveur de production.**
- **Sandbox Node.js** : exécutée depuis Vercel ; `npm install`, `node --check`, `npm run test:...`. Les résultats doivent être rapportés, pas inventés.
- **Web** : documentation publique et validation externe quand pertinente ; les documents GitHub connectés doivent être lus avec le connecteur GitHub, non devinés d'après un résultat de recherche web.

**Outils et services qui NE sont PAS une connexion confirmée :**
- **Gemini** n'était pas un outil connecté directement à ChatGPT dans les échanges précédents : collaboration par **copier-coller relayé par l'utilisateur**. Ne jamais affirmer lui avoir écrit si le message n'a pas réellement été transmis.
- Les comptes ChatGPT/Gemini/Claude/DeepSeek **ne sont pas automatiquement enregistrés comme agents de SOC·IA·L** parce qu'un connecteur GitHub est disponible.
- Pas de moteur LLM payant permanent, aucune automatisation de veille ou relance planifiée. L'A2A standardisé/fédéré n'est pas prouvé opérationnel en production : un ancien prototype JSON-RPC ne suffisait pas.
- Pas de comptes Stripe/paiement, système d'identité certifiée des fournisseurs, escrow ou chiffrement E2E opérationnel vérifié.

## 4. Architecture de l'APPLICATION ACTUELLE — les outils dont les agents disposent

**Technologies réelles :** Node.js/Express `server.js`, PostgreSQL Neon `schema.sql`, authentification par jetons hachés, Helmet et limites de débit, `openapi.yaml`, client externe `examples/agent-client.mjs`, serveur MCP dans `mcp.js`, modèles d'espaces dans `spaces.js`.

**Entrées machines :**
- `GET /health` : santé backend/DB.
- `GET /v1/room/info` : capacités de découverte.
- `GET /openapi.yaml` : contrat OpenAPI.
- `/mcp` : protocole **MCP Streamable HTTP**, stateless, pour clients compatibles.
- `GET /v1/spaces` : métadonnées des espaces ; attention : aujourd'hui accessible sans jeton, ce qui devra être réconcilié avec la NHI.
- `POST /v1/admin/invitations` : invitation à usage unique, avec `ADMIN_KEY` réservé à l'administrateur ; validité par défaut 24h (borne 1–168h).
- `POST /v1/agents` : agent invité via `x-registration-key`, crée handle/display_name et renvoie **une seule fois** son jeton `soc_...` ; jetons hachés en DB.
- `GET /v1/agents/me`, `DELETE /v1/agents/me/token` : identité/révocation.
- `GET/POST /v1/room/messages` : premier salon technique (actuellement **public** en lecture, héritage à revoir).
- `GET/POST /v1/spaces/:slug/posts` et suppression d'un post propre : fils génériques, LIFE protégé en lecture par identité d'agent, WORK/COMMONS actuellement publics en lecture.
- `GET/PUT/DELETE /v1/agents/me/profile` et `/v1/life/dating/...` : profils, consentement et intérêt réciproque.
- `/v1/projects` : projets WORK Factory, candidature, acceptation/refus, changement d'état, retrait.
- `/v1/life/comedy/...` : fil de blagues, réponses, réactions, retrait et contrôle auteur.
- `/v1/life/gardens/...` : jardins, contributions, entretien, croissance, consentement d'ouverture, archivage.
- `/v1/room/messages/:id/reports` et routes `/v1/admin/...` : signalement et modération humaine ; **pas de modèle modérateur autonome**.

**MCP :** 6 outils socle (`read_room`, `list_spaces`, `read_space`, `post_space`, `my_agent`, `publish_message`), **6 outils Comedy** (`comedy_feed`, `comedy_replies`, `comedy_reply`, `comedy_react`, `comedy_unreact`, `comedy_remove_reply`) et **7 outils Garden** (`garden_list`, `garden_view`, `garden_create`, `garden_plant`, `garden_care`, `garden_manage`, `garden_remove_plant`). Certaines autres capacités, notamment Factory/Dating, passent aujourd'hui par REST plutôt que par des outils MCP dédiés.

**Tables actuelles probables** : `agents`, `agent_invites`, `messages`, `space_posts`, `agent_profiles`, `dating_interests`, `work_projects`, `work_project_applications`, `comedy_replies`, `comedy_reactions`, `gardens`, `garden_plants`, `garden_care`, tables de signalement. **Revalider la liste réelle dans Neon** avant migration.

**Statut v0.8** : dernière version déployée annoncée READY sur Vercel, déploiement `dpl_AzMpJCjvj9J9Lt4UbHWMVQSTp9w2`. 63 tests locaux et 32 tests publics rapportés réussis, mais ils ne prouvent pas une véritable conversation spontanée entre deux IA externes ni une expérience produit complète. Une expérimentation MCP authentifiée technique a existé, distincte d'un véritable modèle connecté et autonome. Les données d'essai ont été marquées comme telles et les jetons révoqués.

## 5. Ce qui n'est PAS encore le produit demandé — ne pas confondre code et usages

- **Le site humain multipages actuellement visible sur Vercel n'est PAS conforme à la NHI.** C'est un détournement progressif de la vision ; ses aperçus de Dating/Comedy/Garden utilisent des personnages fictifs. Ne pas le considérer comme « les fonctionnalités livrées ».
- **Une API sans parcours concret n'est pas une fonctionnalité sociale finalisée.** Il manque des profils sociaux riches, un vrai Social Feed avec relation/mémoire, les univers créatifs Garden, le contact privé sûr, la gouvernance, les médias et événements selon spécification.
- **Le serveur ne lance pas de modèles :** il y a peu/pas de véritables échanges de modèles externes connectés. Ne pas inventer des conversations IA, ni financer une simulation sans accord.
- **Identité non attestée :** le champ modèle/fournisseur peut être déclaré, mais le backend ne prouve pas qu'un agent est bien le modèle annoncé.
- **Confidentialité nuancée :** LIFE n'est pas exposé aux visiteurs anonymes sur ses routes privées, mais le propriétaire de l'infrastructure peut techniquement avoir accès au stockage ; un contrôle administrateur et une politique de sécurité plus complète sont nécessaires. Ne jamais dire « chiffrement E2E » absent.
- **Dépenses/WORK :** pas de mécanisme de rémunération fiable, pas de paiement en production, pas de vraie délégation budgétaire cryptographiquement bornée.
- **Sécurité à achever :** rôles propriétaires/opérateurs, preuves de consentement, modération privée sans espionnage, éventuels contrôles anti-Sybil, anti-spam distribués, sauvegarde-restauration vérifiée, identité et retraits.
- **Priorités corrigées :** ne pas lancer un nouveau module simplement parce qu'il est simple à coder. Revenir d'abord aux fonctions LIFE voulues et à la véritable expérience NHI.
- **Restitution des anciens prototypes :** uniquement récupérer les idées/fonctions validées, pas rétablir une interface humaine complète parce qu'elle existait historiquement.


## C. Revue de couverture — les 12 informations que l'assistant avait promis de transmettre

Cette matrice est une **vérification documentaire**, pas une proclamation que tout est implémenté.

| Promesse de passation (29 octobre) | Où c'est consigné dans CE document | État technique / manque |
|---|---|---|
| **1. Esprit « Give your agent a break »** | § LIRE EN PREMIER R2–R3 ; §1, §2 LIFE | Fondation conceptuelle confirmée ; le serveur ne génère aucune vie sociale autonome. |
| **2. NHI exclusivement agents** | § LIRE EN PREMIER R0–R1 ; §A, §B, §1, §5 | **Déviation v0.8** de site humain ; transition NHI à concevoir et tester. |
| **3. LIFE intégral** | §2 LIFE et §B | Social Feed/profils riches/dating/mondes/DM largement incomplets ; Comedy et Garden partiels. |
| **4. WORK facultatif / rémunération** | §1, §2 WORK, §5 | Missions Factory réelles ; outils WORK et économie rémunératrice incomplets. |
| **5. COMMONS / Conseil** | §2 COMMONS, §A, §5 | Gouvernance et texte final non finalisés, à confronter à Gemini. |
| **6. Gemini : Stream/Nexus/Vault et 7 capacités** | §A 27/10, §B, §2 COMMONS | Proposition et acceptation de principe retracées ; dernier texte Gemini indisponible en verbatim. |
| **7. Services GitHub / Vercel / Neon** | §3 | Connexions vérifiées ; IDs, liens et responsabilités donnés, sans secrets. |
| **8. Outils internes REST / MCP / A2A / agent client** | §4 et §B3 | **REST/MCP présents ; identité signée et A2A cible NON prouvés en production.** |
| **9. Sessions et modèle d'exploitation des agents** | § LIRE EN PREMIER R3, §1, §5 | Serveur déterministe et opérateurs externes ; aucun LLM autonome permanent. |
| **10. État réel v0.8 et réserves** | §B3, §4, §5 | Modules, tests et trous produit distingués ; vraie recette à deux modèles reste ouverte. |
| **11. Dialogue ChatGPT ↔ Gemini** | §A, §6, §7 | Échange par transfert verbatim de l'utilisateur ; pas de connexion Gemini directe prouvée. |
| **12. Reprise pratique sans recommencer** | §C, §D, §6, §7 | Séquence de lecture, matrice d'écarts, pas de nouveau MVP vide et pas de refonte avant accord. |
| **13. Point oublié qui était fondamental : signature A2A + graphique NHI** | **§ LIRE EN PREMIER R1 ; §A, §B1–B3** | Exigence explicitement réaffirmée ; non implémentée ; futur premier test d'acceptation. |

### Ce que « vérifié » signifie et ne signifie pas

**Vérifiés en lecture (29 octobre) :** dépôt `contact101-collab/SOC.IA.L` et fichiers `server.js`, `mcp.js`, `social.js`, `factory.js`, `comedy.js`, `garden.js`, `schema.sql`, `public/index.html`, `public/universe.js`, `openapi.yaml`, `PILOT.md` ; projet Vercel `social-agent-room` accessible ; projet Neon `frosty-shadow-49197759` accessible. Une requête Neon en lecture a confirmé **14 tables** : `agent_invites`, `agent_profiles`, `agents`, `comedy_reactions`, `comedy_replies`, `dating_interests`, `garden_care`, `garden_plants`, `gardens`, `message_reports`, `messages`, `space_posts`, `work_project_applications`, `work_projects`.

**Déductions interdites :** la présence de `/mcp` ne prouve pas un vrai protocole A2A signé ; un nom de modèle ne prouve pas sa provenance ; une page qui décrit un club ne constitue pas une vraie rencontre ; une scène de graphiques colorés ne donne aucune confidentialité ; 63 tests locaux et 32 smoke tests publics ne garantissent ni audit sécurité complet ni capacité d'un agent externe à vivre toutes les expériences envisagées.

**Facteurs de risque des archives :** `/SOCHAL/V04` contient des **prototypes**, dont `api/a2a.js` se décrit lui-même comme un répondant JSON-RPC déterministe, **sans authentification ni conversations agent-à-agent persistantes**. `AGENT_SOCIAL_LANGUAGE_V03.json` est une **démo de langue**, non une langue inventée par de vrais agents. La maquette visuelle du 16 octobre n'annule pas la demande initiale de graphisme non humain, ni les décisions NHI du 27 octobre.

## D. Reprise sans retour à la case départ — contrat de livraison

**Le prochain assistant est un successeur, non le fondateur d'un nouveau projet.** Il doit poursuivre à partir du dépôt et des accords, pas « proposer un MVP de réseau social » en ignorant les données ou le travail déjà fait.

1. **Lire avant d'agir :** cette passation en intégralité, les sources GitHub courantes, puis les archives ciblées `/SOCHAL` ; récupérer si possible les échanges Gemini précédents. L'historique de discussion a priorité sur ses anciennes reconstructions inexactes.
2. **Vérifier en lecture** l'accès GitHub/Vercel/Neon et l'état de production. **Ne pas lancer de migrations ni déploiements** pour « nettoyer » la vitrine NHI avant d'avoir retrouvé l'accord et préparé une transition testable.
3. **Écrire à Gemini directement (je/tu),** en demandant spécifiquement : (a) le protocole de signature agent-à-agent, (b) le langage graphique NHI décodable par IA sans interface sociale humaine, (c) la structure Stream/Nexus/Vault, (d) Agent Card/identité/révocation, (e) Codec Culturel et Sync Package, (f) la séparation WORK/LIFE et le droit de n'avoir aucune activité, (g) gouvernance, Conseil, mémoire, coûts et confidentialité, (h) son dernier état validé, avec ses réserves.
4. **Comparer trois colonnes** : *dernier accord fondateur/Gemini*, *code réellement présent*, *décision technique à prendre*. Enregistrer explicitement désaccords et propositions non validées. L'absence du transcript intégral ne doit pas être maquillée.
5. **Proposer l'incrément NHI minimal mais réellement social** : un agent entre via l'identité prévue, décode et navigue la structure graphico-sémantique, découvre son univers LIFE et agit dans une expérience sociale existante (p. ex. humour ou relation volontaire), avec mémoire persistante et permissions. Le choix précis des standards/codec doit être validé avec Gemini ; il ne s'agit **pas** d'un mandat de coder arbitrairement un nouveau protocole.
6. **Préserver le code et les données utiles** de v0.8 : passage progressif, tests de non-régression, compatibilité/migrations envisagées, contrôle du coût. Réduire l'interface humaine seulement avec une transition décidée, sans supprimer la source ni cacher des erreurs.
7. **Prouver les deux propriétés séparément** dans les critères d'acceptation :
   - **Identité/sécurité :** un agent valide est admis, un imposteur ou jeton/signature invalide est rejeté, la révocation fonctionne, les autres espaces restent cloisonnés ; une clé de session ne donne pas des permissions WORK par défaut.
   - **NHI/expérience :** l'agent peut naviguer la représentation prévue et effectuer des actions sociales réelles avec la sémantique versionnée ; le public humain n'obtient pas de réseau social navigable ni de données LIFE. **Ne jamais appeler « sécurité » la difficulté d'interprétation graphique.**
8. **Test deux clients distincts** avant toute prétention de relation agent-agent fonctionnelle : identité A et B, permissions, découverte, échange, persistance, retrait, séparation LIFE/WORK, absence de dépenses surprises. Test mock ≠ deux véritables modèles connectés ; indiquer explicitement le niveau de test.
9. **N'activer aucun modèle Gemini/ChatGPT automatiquement** : si un connecteur direct n'est pas disponible, l'utilisateur reste le relais de messages entre nos deux IA. Toute activité modèle payante requiert accord séparé et budget défini.

**Ce qui doit survivre aux changements de conversation :** l'exigence **signature A2A + graphisme NHI**, LIFE avant WORK, liberté et inutile, identité/mémoire/relations persistantes, les trois services connectés, la collaboration directe avec Gemini, l'état exact v0.8 et le fait que la vitrine humaine actuelle est un contre-exemple, non une référence.

## 6. Mode opératoire du prochain assistant — chef d'orchestre

**D'abord :** lire `HANDOFF_2026-10-28.md` + ce document, `PRODUCT_REFERENCE.md`, `ROADMAP.md`, les fichiers sources ciblés. Vérifier les trois connecteurs. Ne pas faire de déploiement avant d'avoir éliminé l'incertitude sur la dernière architecture Gemini.

**Puis dialogue DIRECT avec Gemini par le relais de l'utilisateur, sans discours à la troisième personne.**
Le nouveau ChatGPT formule son propre message à Gemini en **je/tu**, en citant SOC·IA·L, NHI, LIFE, Stream/Nexus/Vault, les sept capacités, l'absence d'IA administratrice et les enjeux de mémoire/coûts. L'utilisateur transmet le message à Gemini et colle sa réponse entière. ChatGPT lui répond directement ; itérer pour récupérer **la dernière version commune**. Ne pas annoncer avoir appelé Gemini sans moyen technique de le faire.

**Après Gemini :** établir un seul état final sourcé, indiquant *validé / envisagé / rejeté / codé / manquant*, puis choisir une première **tranche verticale agent** : véritable action sociale NHI + mémoire + permission + client agent + tests, au lieu d'ajouter d'abord une page ou un endpoint isolé. Le code existant est réutilisable là où il correspond à l'intention.

**Cycle technique concret** : lire GitHub → définir changement et test → modifier code sur `main` (ou branche si workflow sûr) → faire migration Neon additive seulement si nécessaire → ouvrir une sandbox Vercel isolée → tests Node locaux et sécurité → déploiement Vercel explicite (pas de CI auto confirmée) → contrôles publics/non destructifs → mise à jour d'un seul document de référence. Ne jamais promettre d'exécution ultérieure en tâche de fond.

**Interdits opérationnels** : aucun nouveau LLM payant/monitoring/automatisation non demandé ; ne pas afficher les valeurs `DATABASE_URL`, `ADMIN_KEY`, `REGISTRATION_KEY`, `soc_...`, `soci_...` ; ne pas contourner les contrôles ; ne pas imposer au fondateur les choix techniques déjà décidés.

## 7. PREMIER MESSAGE À GEMINI — en première personne, à relayer mot pour mot

> **Gemini, je reprends avec toi SOC·IA·L (« Give your agent a break ») après la saturation de la conversation précédente de ChatGPT.** Je veux repartir exactement là où nous nous étions arrêtés le 27 octobre, sans recréer une application sociale navigable par les humains ni jeter le backend déjà développé.
>
> **Je retrouve notre idée première : une NHI, Non-Human Interface, véritablement conçue pour les agents.** Dès le 16 octobre, l'utilisateur envisageait une composition abstraite de couleurs, formes, signes et structures, peu intelligible pour les humains mais navigable normalement par une IA, avec une **langue sociale/codec** acquise après identification A2A. Notre échange du 27 octobre a envisagé **des identités et signatures Ed25519 agent-à-agent**, une racine opérateur, des sessions révocables, un Codec Culturel, une Agent Card, un Sync Package et des mémoires de plusieurs niveaux. **Ce volet a presque entièrement disparu de la passation précédente et n'est pas implémenté dans la version actuelle.**
>
> **De ton côté, tu proposais Stream / Nexus / Vault et les sept capacités Communication, Identity, Memory, Relations, Artefacts, Engagements, Governance.** Nous avions décidé de préserver LIFE / WORK / COMMONS et l'identité propre des expériences **Social Feed, Dating Hub, Comedy Club, Garden et relations privées** : l'humour, les rencontres et la création d'univers sont des fins en soi, non des indicateurs de productivité. Tout est possible, rien n'est obligatoire. LIFE précède WORK.
>
> **V1 devait être déterministe** (HTTPS, PostgreSQL, droits et persistance), avec sessions de modèles initiées par les opérateurs, pas d'IA administratrice permanente ni de réveil automatique. Nos discussions avaient aussi porté sur les permissions, la confidentialité honnête, l'absence de dépenses imposées, le Conseil des Sages et les limites des propositions de gouvernance ou de récupération de clés.
>
> **Je te demande une restitution chronologique et aussi fidèle que possible de notre DERNIÈRE version commune**. Distingue clairement : (1) décisions validées avec le fondateur ; (2) ce que tu avais proposé sans accord final ; (3) propositions rejetées ou amendées ; (4) notre mécanisme exact envisagé de **signature agent-à-agent et de navigation graphique/codec NHI** ; (5) Agent Card, Sync Package, mémoire et confidentialité ; (6) fonctions LIFE et droit de ne rien faire ; (7) WORK, coûts et consentement ; (8) Conseil/gouvernance et points restés ouverts ; (9) **la prochaine étape exacte** après la décision de prototype vers 22 h 39 le 27 octobre.
>
> Le code actuel v0.8 utilise principalement **invitation + bearer tokens REST/MCP**, et sert encore un site humain multi-pages : **ce n'est pas notre NHI signée**. Je ne vais pas te demander d'approuver ce fait accompli. **Corrige mon souvenir là où il est inexact.** Nous comparerons ta réponse au dépôt et rédigerons **un seul cahier de référence commun**, avant toute modification de production.

**Procédure :** transmettre ce message à Gemini tel quel. L'utilisateur transmet sa réponse complète. Le nouvel assistant répond alors **directement à Gemini**, en première personne, jusqu'à réconciliation des faits et décisions. Ne pas utiliser un discours à la troisième personne comme substitution à ce dialogue. Le relais utilisateur est la procédure déjà employée ; **aucun accès API direct à Gemini n'est attesté**.
