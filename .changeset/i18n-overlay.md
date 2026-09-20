---
"@bedrock-core/i18n": minor
---

A library's strings can be overridden by the world it runs in.

A library that draws UI ships its own bundle, keyed under a namespace it shares with the rest of
its family. A running realm has more than that: every addon present has announced a bundle, and
one of them may carry the very same key — deliberately, to rename what the library calls something
("Addons" becomes "Mods"), or simply because it ships a locale the library does not.

`overlay(bound, published, bundle)` is that precedence, as verbs. `t()` prefers the published value
wherever it carries the key, so an override and an unshipped locale reach the strings a script
renders rather than only the keys a client paints. `resolve()` and `display()` become the world's,
so a key from any addon's bundle resolves — which is what a screen showing another addon's display
fields needs.

A realm with no published bundles gets the bound instance back untouched and allocates nothing.
