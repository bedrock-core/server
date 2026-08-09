# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).
It tracks pending version bumps + changelog entries for the publishable packages
(`@bedrock-core/sync`, `@bedrock-core/server-runtime`). The reference addons
(`packages/test-addon*`) are `private` and are ignored automatically.

## Authoring a changeset

When you make a change worth releasing, run:

```sh
yarn changeset
```

Pick the affected package(s) and a bump level (`patch` / `minor` / `major`),
write a short summary, and commit the generated `.changeset/<name>.md` alongside
your change.

## How releasing works

Releasing is a single manual **"Publish Release"** GitHub Action
(`workflow_dispatch`, no inputs — just pick the branch). It:

1. installs only the publishable libraries with `yarn workspaces focus` (so the
   `portal:../ui` resolutions used by the test addons are never touched — the
   release is self-contained and does not need the sibling `ui` checkout);
2. runs `changeset version` — consumes the pending changesets, bumps the changed
   packages **and their dependents** (`updateInternalDependencies: patch`, e.g. a
   `sync` bump patches `server-runtime`), and writes CHANGELOGs;
3. publishes the changed packages to npm (`workspace:^` ranges are rewritten to
   concrete versions by `yarn npm publish`) and tags each
   `@bedrock-core/<name>@<version>`.
