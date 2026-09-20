/**
 * Guarding engine handles.
 *
 * `Entity`, `Player`, `Block`, `Camera`, `Component`, `Container`, `ContainerSlot`, `Effect`,
 * `ScoreboardIdentity`, `ScoreboardObjective`, `ScreenDisplay`, `Structure` and `Waypoint` all
 * expose a readonly `isValid`. It goes false once the thing the handle points at is gone —
 * despawned, disconnected, or moved into an unloaded chunk — and from then on every other member
 * throws `InvalidEntityError` on access.
 *
 * This matters most for a handle that outlives the moment it was obtained: one stored in a map, or
 * one delivered by an `afterEvents` subscriber, which by definition runs after the fact. A throw
 * from inside an event subscriber is not caught by the caller; the engine catches it, logs it
 * against the *pack's* name, and continues. For a library that means an addon depending on this
 * runtime gets errors attributed to itself, so nothing here may throw out of a subscriber.
 *
 * `Entity.id` is the documented exception: it stays readable when `isValid` is false, which is why
 * id-keyed bookkeeping still works for a handle that has gone stale.
 */

/** Anything the engine can invalidate. Plain objects, which have no `isValid`, are always usable. */
export interface EngineHandle {
  readonly isValid?: boolean;
}

/**
 * Whether a handle can still be touched.
 *
 * False for `null`/`undefined` and for an invalidated handle; true for everything else, including
 * objects that have no `isValid` at all. Narrows away the nullish case, so a stored handle can be
 * looked up and checked in one step.
 */
export function isUsable<T extends EngineHandle>(handle: T | null | undefined): handle is T {
  return handle != null && handle.isValid !== false;
}
