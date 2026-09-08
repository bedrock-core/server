# Follow-ups from the docs site

Temporary. Delete items as they land. Docs sections: `/docs/server` (runtime + API), `/docs/sync`; `db` and `observable` are listed as planned until phase 7 gives them pages.

## Comments

| Location | Text | Action |
| --- | --- | --- |
| `packages/sync/src/wire.ts:1-9` | "used to be nested inside a Frame" | drop the paragraph; the "A message opens with a tag" block already states the fact |
| `packages/sync/src/constants.ts:47` | "no longer travels inside a frame" | "travels verbatim" |

## JSDoc

- `/** */` on every export; 5 exports in `packages/server-runtime/src` carry a `//` line instead.
- Coverage: `observable` 6 of 14, `server-runtime` 60 of 106, `db` 22 of 33.
- No `@param` / `@returns` anywhere in this repo; prose-only JSDoc is fine, but every export needs the block.

## Docs backlog waiting on code (phases 7 and 10 of `09-plan.md`)

- New sections `db`, `observable`, `query`, from the package READMEs.
- `server` API: the db re-exports, `flattenSchema` / `flattenGroups` / `isGroupMetaKey`, `EntityScope` / `ScopeTree`, `CONFIG_COLLECTIONS`, `defaultsOf` / `normalizeAgainst` / `coerce`, `isUsable`, `isReservedStateKey`, `sharedDpKey`, `AddonPageReference`.
- `sync`: `SELF_CAPS`, `capsFor`, `negotiateProtocol`.
- The trust-model page and the "installing is trusting" sentence in get-started.

## READMEs

At 1.0, each package README becomes one paragraph, the install line, one example and a link to its docs section.
