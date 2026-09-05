# 07 — Trust model

## The facts the design rests on

1. Every behavior pack runs arbitrary script with the full `@minecraft/server` surface. It can kill
   players, write any dynamic property (including `core-cfg:*`), send any script event.
2. Script events carry **no sender identity**. `scriptEventReceive` gives a message id and a
   string; the `from` in a sync envelope is whatever the sender wrote. There is no primitive in
   the platform that lets a realm prove which pack it is.
3. Code cannot cross realms. A pack can send another pack *data*; it cannot make it *run anything*
   that pack's own code does not already do with data.

From (3): the framework **cannot be patched, hooked or code-injected** by another pack. Its
functions live in the realm that imported it; no message reaches them except through handlers the
runtime itself registered. That part of the question has a clean answer: no.

From (1) and (2): everything the framework holds as *data* can be spoofed. Any pack can publish a
schema under another addon's namespace, answer an RPC as any node, write any replicated-state key,
register a patch claiming to be `os_shop`, or overwrite the DP `core-cfg:s:drav0011_economy:taxRate`
directly — the last one without touching bedrock-core at all.

## What follows — *Decided*

**Do not build defenses against a hostile pack. There is nothing to build them on.**

- Signing or an HMAC needs a secret; the secret lives in the pack; every pack can read it. Theatre.
- An allowlist of trusted namespaces is data in the same realm-readable place. Theatre.
- The installed-pack list is not readable from script. Nothing can be cross-checked.

This is the same trust model as Java mods, Node packages and browser extensions: **installing a
pack is trusting it.** The docs say so in one sentence, once, and stop worrying about it.

## What "security" means here, then

Three things are real and worth doing:

### 1. Player authorization — exists, keep extending it

The boundary that actually exists is between a **player** driving a UI or a command and settings
they may not touch. `authorization.ts` already keys off an actor and reads the readonly
`playerPermissionLevel`. Every new player-facing write path (entity, block, store RPCs) carries
`actorId` and goes through `denyReason`. No new mechanism.

### 2. Robustness against a *buggy* pack — the real threat

A bug in one addon must not take down the world's other addons. This is where the effort goes:

- **Validate every inbound payload's shape** before acting on it. RPC already does; patches,
  store and config-changed messages do the same. Malformed → log with the claimed sender, drop.
- **Failure isolation at every cross-realm boundary.** A patch handler that throws is caught,
  counted, and the patch is **disabled after N consecutive failures** with a diagnostic naming the
  addon. The target function keeps running unpatched. Same for a subscriber that throws.
- **Timeouts everywhere a reply is awaited** — already the RPC rule; the patch system inherits it.
- **Coerce on read**, never trust stored shape — `persistence.ts` already does for config; the
  store does the same for chunk indexes.

### 3. Accidental collision — exists

Two addons choosing the same namespace is far likelier than an attacker, and the registry already
reports it. The patch system adds the same for two patches both claiming `replace` on one point.

## Where the patch system sits in this

Patches make the trust model *visible* rather than change it: the owner opted in with a declared
point, the patcher runs its code in its own realm, and what crosses is data the owner's generated
dispatch interprets. A malicious pack gains nothing it did not already have. A buggy patch is
caught by §2. The docs should say exactly this so nobody asks for a sandbox that cannot exist.

## Non-goals

- Cryptographic identity of packs. Not possible; not attempted.
- Sandboxing another addon's code. No such primitive.
- Hiding data from other packs. Dynamic properties are world-global; `core-` prefixes are a
  namespace convention, not a permission.
