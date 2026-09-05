# 06 — Patching — *Proposed: `script_eval` first*

One addon changes the behavior of another, in the spirit of Java Mixins, without the target being
designed around every addon that might want to. Reopened 2026-09-02 after the
[functions-from-strings spike](./spikes/S-function-from-string.md): with the `script_eval`
manifest capability a target realm can compile a patcher's source text at native speed, which
makes real, synchronous patches possible. That is the tier built first. The **expression tree**
tier — the same thing with a bounded evaluator instead of `Function` — is parked as the fallback
if in-game tests or the security verification below say so.

## Principle for the docs — *Decided*

Stated as a rule, not a recommendation:

> **Typed RPC first.** A capability you *intend* others to use is a typed RPC method. A patch point
> is an admission that a normal API is insufficient for this one function — it is opt-in, versioned,
> and not a stable public API.

## What the boundary forbids — and the one thing it allows

None of the facts below can be engineered around; the design fits them.

1. **No code object crosses realms.** Only data does — and with `script_eval`, *source text is
   data*. The target compiles it; nothing of the patcher's realm comes with it.
2. **No reply arrives on the tick it was asked for.** So the patch body must already live in the
   target when the call happens: sent once at registration, compiled once, called forever.
3. **Only serializable values cross.** Irrelevant here — the body runs where the real `Player`,
   `Block`, `ItemStack` already are. Nothing about the call crosses at all.
4. **`Function` needs `script_eval` in the manifest of the pack that calls it** — the target.
   Measured: native speed, ~9 µs per compile, body scope is exactly `console` and `print`. No
   imports, no closures — everything the body uses is passed in. The capability (per the user)
   excludes the pack from Marketplace; *verify against current guidelines* before this is
   documented as a rule.

Consequences carried over from the first review:

- The target **must declare the point**. No build step can make an undeclared function reachable;
  reaching it means the target's own code dispatches to the patch.
- `@PatchPoint()` cannot exist — decorators do not apply to standalone functions. The wrapper is a
  plain call.

## The shape — *Proposed*

### Target

```ts
// os_shop — manifest declares "capabilities": ["script_eval"]; the build refuses this call otherwise
export const calculateDamage = core.patchPoint(
  'calculateDamage',
  (player: Player, damage: number): number => damage,
);
```

`patchPoint` returns a function of the same signature. With no patch registered it is the original
plus one `chain.length === 0` check (S3 measures that). Arg names are taken from the function by
the build and become the keys of `ctx.args`.

### Patcher

```ts
// drav0011_hardcore — ordinary TypeScript, type-checked against os_shop's published PatchPoints type
core.patch<OsShop>('os_shop:calculateDamage', {
  priority: 100,
  requires: { version: '^1.2' },
  before(ctx, mc) {
    if (ctx.args.player.hasTag('boss')) { ctx.args.damage *= 2; }
  },
  after(ctx, mc) {
    if (ctx.result > 100) { mc.world.sendMessage(`${ctx.args.player.name} hit for ${ctx.result}`); }
  },
});
```

Also `around(ctx, mc, next)` (call `next()` for the rest of the chain, or not) and `replace` —
`around` with no `next`, at most one patcher per point.

**Every handler runs synchronously in the target's realm.** `ctx.args` are the live objects the
target was called with; `mc` is the `@minecraft/server` namespace the target passes in, so
`world` / `system` are available without an async import. The patcher's own state is reachable
through `ctx.shared.get(ns, key)` — the shared mirror every realm holds ([02-shared](./02-shared.md)) — and that is the
patcher's way to hand its config or flags to its patches (publish what a patch needs via
`core.shared`; config *values* are not mirrored and are not visible here).

**What a handler cannot use**: anything from the patcher's module scope — imports, closures,
its own functions and maps. The build rejects each free variable with the line and the name;
allowed identifiers are the parameters, JS globals (`Math`, `JSON`, `Object`, …) and `console`.

### What crosses, and when

1. Build: the patcher's handlers are extracted as source strings with their free-variable check
   passed, into `patches.generated.json`.
2. Boot: the patcher registers with `core:patch.register { point, handlers: { before?: string, … },
   priority, requires }` over RPC to the owner.
3. Owner: validates the point exists, the version satisfies `requires`, no second `replace`; then
   `new Function('ctx', 'mc', 'next', body)` per handler, once. Rejections go back with a reason
   the patcher logs.
4. Calls: the chain runs in place. Nothing is sent.

## Failure isolation — and the one thing it cannot catch

Each handler runs inside a `try`. A throw is caught, counted, logged with the patcher's namespace
and the point, and after N consecutive failures the patch is disabled with a diagnostic
([04-trust-model](./07-trust-model.md#2-robustness-against-a-buggy-pack--the-real-threat)). The
target keeps running unpatched.

**An infinite loop is not a throw.** A handler that never returns trips the script watchdog, and
the watchdog terminates the *target's* realm — the patcher's bug takes down the addon it patched.
No runtime mechanism catches this; it is the accepted cost of running real code, and the first
item on the verification list below. If it turns out unacceptable, the expression tree tier
(bounded by construction) is the answer.

## Security verification — before this ships

The trust model does not change: a pack can already do anything to the world from its own realm.
What `script_eval` adds is a patcher's code running with access to whatever `ctx` exposes of the
target. Keep `ctx` minimal — args, result, `cancel`, `state` — and never pass the target's module
scope. Then verify, in game:

1. **Watchdog behavior.** An infinite loop in a handler: which realm dies, does the world survive,
   is it recoverable without a restart, what does the content log say.
2. **Scope containment.** Measured already: `globalThis` inside a compiled body is `console,print`.
   Re-check with `mc` passed in that nothing else leaks (prototype walks from `ctx.args.player`
   reach the engine, which is fine — the engine is world-global anyway).
3. **Diagnostics.** Does an exception thrown inside a `Function` body carry a stack the log can
   attribute to the patcher? If not, the wrapper stamps the namespace on every log line.
4. **Marketplace.** The `script_eval` restriction is user-stated. Find the rule in writing.
5. **Cost with real handlers.** S3 below.

## Build-time responsibility

Target side (the bundler filter):

1. Discover `core.patchPoint('<name>', fn)` calls; emit `patch-points.generated.json` — name, arg
   names, and the function's TS signature.
2. Refuse the build if any point exists and the manifest lacks `"capabilities": ["script_eval"]`.
3. Export a `PatchPoints` type per addon, published the way a config type is, so a patcher gets
   `ctx.args` and `ctx.result` typed.

Patcher side:

4. Extract each handler's source; run the free-variable check; emit `patches.generated.json`.
5. Stable ids are `<namespace>:<name>` from the string the author wrote, never a file path.

**Against auto-marking every export.** The bundler could wrap every exported function. It would
cost the dispatch check on every call and turn every internal refactor into a breaking change for
someone. Not in 1.0; revisit only if asked.

## Runtime responsibility

- Owners publish their point manifest to replicated state under `core-patch/points` (small, static — like the config schema).
- Registration, validation and rejection as above; `requires` checked against the registry's known version of the target.
- Chain order: `priority` desc, then namespace asc — deterministic, never load order.
- A patcher leaving (registry `onUnregister`) drops its patches; rejoining re-registers.
- `core.patches.disable(point, ns)` for the failure-isolation rule and for operators.

## Parked: the expression tree tier

Same registration, same chain, same `ctx` — but the handler is compiled at build into an
expression tree and evaluated by a small evaluator the runtime ships. Pure expressions over args,
result, state; `cancel` / `returnWith`; no statements, loops or engine calls (those go async via a
notify-after event). Bounded by construction, no manifest capability, Marketplace-safe, ~1 week.
Built only if the verification above fails or a Marketplace-bound addon needs to *host* points.

## Measure — S3

1. Per-call overhead of `patchPoint()` with zero patches, one string handler, five — in a tight
   loop in game. Bar: zero-patch cost indistinguishable from a plain call.
2. Registration round trip: ticks from patcher boot to a compiled chain in the owner, one and
   three patchers.
3. Verification items 1–3 above, recorded in a findings page whichever way they go.

## Non-goals

- Patching functions the owner did not mark. Impossible across realms; not attempted.
- Passing the target's module scope, or anything beyond `ctx` and `mc`, into a handler.
- Patching the framework itself. Runtime functions are not patch points.
