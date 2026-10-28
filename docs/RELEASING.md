# Releasing IbuJS to npm

Releases are built and published by `.github/workflows/release.yml` when you push a tag such as `v0.7.0`. The workflow:

1. checks the tag matches `package.json`'s version,
2. runs `npm run check` (typecheck, tests, security check, build),
3. runs `node scripts/release.mjs --verify`, which compiles the packages to JavaScript + type declarations in `.release/`, packs them, creates a fresh app from the packed tarballs and builds and runs it,
4. publishes `@ibumomujs/ui`, `@ibumomujs/server`, `@ibumomujs/ai`, `@ibumomujs/cli` and `create-ibumomujs` with **provenance** (a signed statement, shown on npmjs.com, that each package was built from this repository by this workflow).

It uses npm **trusted publishing** (GitHub OIDC): no long-lived npm token is stored in GitHub. It needs npm 11.5.1+ (installed by the workflow) and GitHub-hosted runners.

## One-time setup

1. **npm account**: create one at npmjs.com and turn on two-factor authentication.
2. **Names**: the packages are published under the npm organization `ibumomujs` (scope `@ibumomujs/`), because `ibujs` was not available. `create-ibumomujs` is an unscoped name; it was free on 2026-10-28, so publish it soon to keep it. To move to another scope later, replace `@ibumomujs/` everywhere (`git grep -l @ibumomujs/`) and rename `packages/create-ibumomujs`.
3. **GitHub environment**: in this repository, Settings → Environments → New environment → `npm`. Add yourself as a required reviewer if you want to approve each release by hand.
4. **Trusted publishers**: for each of the five packages on npmjs.com, open Settings → Trusted publishing → GitHub Actions and enter: owner `PrinceIbrahim51`, repository `Ibujs`, workflow `release.yml`, environment `npm`.
   - npm may only let you configure this for a package that already exists. If so, do the **first** release with a token: create a granular access token with publish rights for the packages, save it as the `NPM_TOKEN` secret in the `npm` environment, push the tag, then configure trusted publishing and **delete the token and the secret**. Later releases need no token.

## Each release

```bash
# 1. bump every package to the same version (the release script refuses mismatches)
npm version 0.7.1 --no-git-tag-version --workspaces --include-workspace-root
# 2. update CHANGELOG.md, then commit
git commit -am "Release 0.7.1"
# 3. tag and push
git tag v0.7.1 && git push && git push --tags
```

Dry run locally at any time: `node scripts/release.mjs --verify` (nothing is published).

## Signed tags (optional)

Provenance already ties each package to a commit. To also sign the tags themselves, configure a GPG or SSH signing key (`git config tag.gpgSign true`) and add the public key to your GitHub account, so tags show as "Verified".
