# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).
It tracks pending version bumps + changelog entries for the publishable packages
(`@bedrock-core/server`, `@bedrock-core/server-runtime`, `@bedrock-core/sync`).
The monorepo root and the reference addons (`packages/test-addon*`) are `private`
and are ignored automatically.

## Authoring a changeset

When you make a change worth releasing, run:

```sh
yarn changeset
```

Pick the affected package(s) and a bump level (`patch` / `minor` / `major`),
write a short summary, and commit the generated `.changeset/<name>.md` alongside
your change.

## How releasing works

Releasing is automatic. The **Release** workflow (`.github/workflows/publish.yml`)
runs on every push to `main` and, through `changesets/action`, does one of two
things:

- **Changesets are pending** → it opens (or refreshes) a **"Version Packages"** PR
  built by `yarn version-packages`. That runs `changeset version` — consuming the
  pending changesets, bumping the changed packages **and their dependents**
  (`updateInternalDependencies: patch`, e.g. a `sync` bump patches
  `server-runtime`) and writing CHANGELOGs — then
  `scripts/sync-runtime-version.mjs`, which rewrites `RUNTIME_VERSION` so the
  constant can never disagree with the tag that ships it. The PR is refreshed on
  every further push while it stays open.
- **No changesets left** → merging that PR lands the bumps on `main`, and the run
  that follows executes `yarn release` (`lint:libs`, `build:libs`, then
  `changeset publish`): each changed package goes to npm, gets tagged
  `@bedrock-core/<name>@<version>`, and gets a GitHub release.

Only the publishable libraries are installed for the release (`yarn workspaces
focus`), so the `portal:../ui` resolutions the test addons use are never resolved
and the job needs no sibling `ui` checkout.

The `workspace:` ranges the libraries use to depend on each other must come out of
the tarball as concrete versions. **Release rehearsal**
(`.github/workflows/rehearsal.yml`, `workflow_dispatch`) is what proves they do:
it publishes every package to a throwaway local registry and installs each one
from a clean consumer. Run it before any release you care about.

Two repo settings the workflow depends on:

- *Allow GitHub Actions to create and approve pull requests* (Settings → Actions →
  General) — without it the Version PR can't be opened.
- An `NPM_TOKEN` repository secret with publish rights on the `@bedrock-core`
  scope.
