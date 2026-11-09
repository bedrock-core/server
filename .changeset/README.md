# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).
It tracks pending version bumps and changelog entries for the publishable packages:
`@bedrock-core/server`, `@bedrock-core/server-runtime`, `@bedrock-core/sync`,
`@bedrock-core/db`, `@bedrock-core/observable` and `@bedrock-core/i18n`. The public
root package is included explicitly through `workspaces: [".", ...]`. The private
GameTest fixtures are excluded from releases.

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
  Packages"** PR through `changeset version`,
  consuming the pending changesets, bumping the changed packages **and their
  dependents** (`updateInternalDependencies: patch`) and writing CHANGELOGs.
  `yarn version-packages` runs the same command locally. Nothing is published from
  a push.
- **A manual run** (Actions, Release, Run workflow) after that PR merges runs
  `yarn release`: `lint:libs`, `build:libs`, `scripts/publish-tarballs.mjs`,
  and `changeset git-tag`. Each changed package goes to npm
  through trusted publishing (OIDC), with no npm token, and is tagged
  `@bedrock-core/<name>@<version>`.

**`@bedrock-core/server` and `@bedrock-core/server-runtime` form a fixed release
group.** A changeset for either package releases both at the same version,
including prerelease tags. Both are valid changeset targets. The other libraries
are versioned independently. `RUNTIME_VERSION` reads Server Runtime's package
metadata directly.

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
