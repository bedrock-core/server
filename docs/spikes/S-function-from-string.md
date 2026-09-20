# Spike — functions from strings

**Question.** Can a patch body travel as source text and be compiled in the target realm?

**Answer (2026-09-02, 1.26.43, in game): yes, but only with the `script_eval` manifest
capability — which the target pack must declare, and which (per the user) Marketplace content
may not use.**

## Without the capability

| Call | Result |
| --- | --- |
| `new Function('a', 'return a * 2')` | `TypeError: Function from string is not supported` |
| `Function('return 1 + 1')` | same |
| `eval('1 + 1')` | `ReferenceError: 'eval' is not defined` |

## With `"capabilities": ["script_eval"]` in `manifest.json`

| Probe | Early execution | Tick 1 |
| --- | --- | --- |
| `new Function('a','return a*2')(21)` | `42` | `42` |
| `Function('return 1+1')()` | `2` | `2` |
| `eval('1+1')` | `2` | `2` |
| body sees module import `world` | `undefined` | `undefined` |
| body sees `console` | `object` | `object` |
| `Object.keys(globalThis)` inside the body | `console,print` | `console,print` |
| handle passed as a parameter, `w.getAllPlayers().length` | early-execution refusal (engine rule, not eval's) | works |
| `ctx` bag passed in and mutated (`ctx.args.damage *= 2`) | `10` | `10` |
| `import("@minecraft/server")` inside the body | returns a Promise | returns a Promise |
| 100 000 calls, native vs compiled | 13 ms vs 11 ms | 11 ms vs 12 ms |
| 1 000 compiles | 9 ms | 9 ms |

## What it means

- **Speed is a non-issue.** A `Function`-compiled body runs at native speed — the engine
  compiles both to the same bytecode — and a compile costs ~9 µs. Compile once at registration,
  call forever.
- **A compiled body sees nothing of either realm.** Its scope is `console` and `print`. No
  module imports, no patcher closures. Everything it uses must be passed as parameters — the
  `ctx` bag, and the engine module namespace itself if the body needs `world`/`system`
  synchronously (dynamic `import()` works but is async).
- **The target opts in, not the patcher.** The capability is a manifest field on the pack that
  calls `Function`, i.e. the one hosting the patch point. Declaring it is what would cost that
  pack its Marketplace eligibility — so a Marketplace-bound addon can never host string patches,
  whatever the patcher does.

Probe was `packs/BP/scripts/probe-function.ts` in `test-addon` with the capability added to its
manifest; both removed once this page was written.
