# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).
It tracks pending version bumps and changelog entries for the publishable packages:
`@bedrock-core/server`, `@bedrock-core/server-runtime`, `@bedrock-core/sync`,
`@bedrock-core/db`, `@bedrock-core/observable` and `@bedrock-core/i18n`. The monorepo
root and the GameTest fixtures are `private` and are ignored automatically.

## Authoring a changeset

When you make a change worth releasing, run:

```sh
yarn changeset
```

Pick the affected package(s) and a bump level (`patch` / `minor` / `major`),
write a short summary, and commit the generated `.changeset/<name>.md` alongside
your change.

## How releasing works

The **Release** workflow (`.github/workflows/publish.yml`) has two jobs:

- **A push to `main` with changesets pending** opens (or refreshes) a **"Version
  Packages"** PR built by `yarn version-packages`. That runs `changeset version`,
  consuming the pending changesets, bumping the changed packages **and their
  dependents** (`updateInternalDependencies: patch`) and writing CHANGELOGs, then
  `scripts/sync-meta-version.mjs` and `scripts/sync-runtime-version.mjs`, which set
  the root meta's version and rewrite `RUNTIME_VERSION`. Nothing is published from
  a push.
- **A manual run** (Actions, Release, Run workflow) after that PR merges runs
  `yarn release`: `lint:libs`, `build:libs`, `scripts/publish-tarballs.mjs`,
  and `scripts/tag-packages.mjs`. Each changed package goes to npm
  through trusted publishing (OIDC), with no npm token, and is tagged
  `@bedrock-core/<name>@<version>`.

**`@bedrock-core/server`'s version IS `@bedrock-core/server-runtime`'s**,
character for character, prerelease tag included. The runtime is what the meta
is; `db`, `observable`, `sync` and `i18n` are support around it, so a consumer
reading either number is reading the same one. A release the runtime does not move
leaves the meta where it is. The root is not a valid changeset target: do not
select it.

`0.0.0` is what an unreleased package sits at, and `publish-tarballs.mjs` skips it.

Only the publishable libraries are installed for the release (`yarn workspaces
focus`), and nothing is checked out beside this repository: every dependency
resolves from the registry. The root `resolutions` must carry versions rather than
`portal:` entries before a release can install; that swap is the release step.

The `workspace:` ranges the libraries use to depend on each other come out of each
tarball as concrete versions, because `publish-tarballs.mjs` packs with Yarn.

Two things the workflow depends on:

- *Allow GitHub Actions to create and approve pull requests* (Settings, Actions,
  General). Without it the Version PR cannot be opened.
- A trusted publisher on npmjs.com for each package, naming this repository and
  `publish.yml`.
