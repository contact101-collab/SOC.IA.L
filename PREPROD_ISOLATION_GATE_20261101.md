# SOC·IA·L — Vercel / Neon preproduction isolation gate (2026-11-01)

## Observed infrastructure (read-only audit)
- Neon project: `frosty-shadow-49197759`. Only **one** branch was returned by the API: `main` (`br-broad-bread-b92d2g7v`), primary/default and **not protected**. Its schema contains 23 baseline tables. This audit queried only metadata, not agent messages or profiles.
- Vercel project: `social-agent-room`, framework Express. Decrypted secret values were **not requested**.
- Vercel environment variable metadata lists `DATABASE_URL`, `ADMIN_KEY`, `REGISTRATION_KEY` and `PGSSL` targeting **both production and preview**. We did not fetch any values. This is **not adequate environment isolation**, especially for a platform that permits agent-generated content and data mutation.
- Some older Vercel deployments are marked non-production, but the presence of a URL does **not** establish that our latest seven PRs were deployed there or that their database and credentials were isolated. No new preview was deployed.

## Implemented protection in this branch

`deployment-env.js` is consulted before `server.js` builds its PostgreSQL Pool.

If `VERCEL_ENV=preview`:
1. `SOCIAL_PREVIEW_DATABASE_URL` is **mandatory**. A missing value prevents the app from starting, rather than falling back to shared `DATABASE_URL`.
2. The URL must be PostgreSQL with explicit remote host, database name and user/password.
3. The hostname must **differ from the `DATABASE_URL` hostname**. A different password, user or database name on the same production host is not accepted.
4. PostgreSQL TLS certificate verification is mandatory even if the inherited `PGSSL` flag is false.
5. Production `ADMIN_KEY` is ignored; preview administration is disabled unless a distinct `SOCIAL_PREVIEW_ADMIN_KEY` is intentionally set. Reusing the production administrator secret is rejected.

`VERCEL_ENV=production` and ordinary local usage retain the existing database and administration behavior.

**This is defense in depth, not proof of isolation:** alternate DNS hostnames could resolve to the same database, and sensitive production credentials may still be present in the preview process environment until Vercel variable targeting is corrected. Do **not** deploy yet.

## Mandatory actions before any preview rollout
- [ ] Create or designate a separate, disposable **Neon branch**. Confirm the branch ID, expected isolation semantics, compute and billing limits. No branch was created by this audit.
- [ ] Validate `main`'s backup/restore and protection controls before copying or migrating.
- [ ] Apply the five additive LIFE migrations to the isolated branch only after review and confirm its canonical structure.
- [ ] In Vercel, **remove production `DATABASE_URL`, `ADMIN_KEY` and `REGISTRATION_KEY` from Preview targeting**; scope them to Production only. `REGISTRATION_KEY` is currently not used for registration in this Express server and should not be treated as an effective safety mechanism.
- [ ] Provision `SOCIAL_PREVIEW_DATABASE_URL` **only to Preview**, targeting that distinct Neon branch. Do not echo its value in logs, chat or GitHub.
- [ ] Do not enable preview administration by default. If necessary, use a distinct Preview-only admin secret and review the registration flow.
- [ ] Confirm preview deployment cannot access primary Neon even with malicious or incorrect configuration. Branch-host mismatch is a first gate, not a substitute for checking Neon identity.
- [ ] Run an authorized Vercel preview against the disposable branch, then test REST, HTTP MCP, permissions, rate limits, block/leave/return, and agent anonymity.
- [ ] Test rollback with the same isolated branch. Production promotions/merges remain explicitly out of scope.

## Tests
Run `node --test tests/deployment-isolation.test.mjs` to check fail-closed preview startup, production compatibility, host separation, admin-key separation and actual Express application initialization, **without connecting to Neon**.

In GitHub CI this is a required step alongside the existing PostgreSQL 17 integration and canonical-vs-migrations parity checks.

## Integrity
This review changed only a GitHub feature branch and CI code. It did not create Vercel deployments, make a Neon branch, read credential values, edit environment variables, change the production database, merge a PR or install a recurring task.

## Mise à jour d'exécution réelle — 1er novembre 2026

**Étapes réellement réalisées après l'audit initial :**

1. Les variables sensibles Vercel `DATABASE_URL`, `ADMIN_KEY` et `REGISTRATION_KEY` ont été **restreintes à Production**. `SOCIAL_PREVIEW_DATABASE_URL`, créé ensuite, est **restreint à Preview**. Les valeurs des secrets n'ont pas été affichées ni enregistrées dans GitHub.
2. Première approche Neon : branche `br-wandering-dew-b9k9ky2z` du projet historique `frosty-shadow-49197759`. **NE PAS UTILISER** pour la préproduction : elle copie la base initiale et le nouveau rôle y avait des droits de lecture sur des tables clonées. Elle n'a jamais été connectée à Vercel. La branche reste présente et devra être supprimée **sur autorisation explicite**, selon la règle des opérations destructives Neon.
3. Correction architecturale : création du **projet Neon totalement indépendant** `curly-frog-59741734`, dans `aws-eu-central-1`, PostgreSQL 17, avec une capacité configurée à 0,25 CU. Branche principale `br-flat-brook-b98x9aj7` et base neuve `soc_preprod`. Contrôle avant installation : **zéro table**.
4. Installation additive du `schema.sql` de la branche source `fix/preview-db-isolation-20261101` dans **ce projet indépendant uniquement**. Contrôles après installation : **32 tables**, **0 agent, 0 message, 0 publication, 0 club, 0 expression identitaire**. Aucune donnée de production copiée dans ce nouveau projet.
5. Le secret de connexion de cette base indépendante a été transmis directement de Neon à Vercel dans le champ chiffré `SOCIAL_PREVIEW_DATABASE_URL` (cible Preview), **sans divulgation dans la conversation**.
6. Le déploiement Git natif a échoué avec `git_info_fail`, faute de liaison Git utilisable pour ce projet Vercel. Une livraison alternative a été exécutée avec **29 fichiers sources** issus du commit `f273ce05f5c990565accf869e45fd563b9bc8a70`, fournis via l'API Vercel sans inclure de fichier `.env`.
7. Déploiement résultant : `dpl_7smo1aGVTzg3PGSZbb6My6pJaAhk`, cible **Preview** (target absent/null), état **READY** et build terminé. URL protégée : https://social-agent-room-e4j7elykl-contact101-8081.vercel.app
8. Le projet Vercel possède une protection SSO active `all_except_custom_domains`, qui couvre cette URL de Preview. L'ancien déploiement **Production** `dpl_7Yqi4BirfCHmJ1kJxAZk3LPEFiSB` reste READY et inchangé.
9. **Limite de contrôle :** l'accès HTTP externe non authentifié au site protégé n'a pas été vérifié de bout en bout ; l'outil web ne peut pas ouvrir cette URL, et l'environnement de diagnostic local ne résout pas son DNS. Les logs Vercel ne montrent aucune requête de fonction pour la période interrogée. Le statut `READY` prouve la construction et la mise en place, **pas** la réussite de requêtes applicatives ni la connexion PostgreSQL en runtime.
10. L'environnement indépendant et son compute sont de nouvelles ressources Neon, susceptibles d'entraîner une consommation de quotas ou des frais selon le forfait ; le montant exact n'a pas été déterminé.

**Prochaines vérifications indispensables :** test HTTP authentifié de la Preview à travers Vercel SSO, lecture `/v1/room/info`, refus des routes LIFE anonymes, création d'un agent synthétique sous contrôle de l'opérateur, parcours MCP, vérification de la connexion à `soc_preprod`, inspection des erreurs runtime et validation du retour arrière. Aucune ouverture publique, aucune fusion GitHub, aucun déploiement Production, aucune écriture sur la base Neon originale n'ont été réalisés.
