// IEventBus — the contract for Zana's nervous system.
//
// The concrete bus is a Node EventEmitter singleton in bus.ts (in-process,
// synchronous delivery). Callers across packages emit/subscribe to the EVENTS
// names. Depending on THIS interface (rather than the concrete EventEmitter)
// means a future out-of-process implementation — a Redis/NATS adapter that
// satisfies the same emit/on/off shape — could be swapped in without changing
// any emitter or subscriber. (That swap is explicitly out of scope now; the
// interface just keeps the door open.)
//
// Type-only module — no runtime code.

import type { EVENTS } from "../bus";

/** The string literal union of all known event names (e.g. "agent:spawned"). */
export type ZanaEventName = (typeof EVENTS)[keyof typeof EVENTS];

/** A bus listener. Payload is event-specific; typed per-event refinement can
 *  layer on top later without changing this base contract. */
export type EventListener = (payload: any) => void;

export interface IEventBus {
  /** Fire an event to all current listeners. In-process impl is synchronous. */
  emit(event: ZanaEventName | string, payload?: any): boolean;
  /** Subscribe to an event. */
  on(event: ZanaEventName | string, listener: EventListener): unknown;
  /** Unsubscribe a previously-registered listener. */
  off(event: ZanaEventName | string, listener: EventListener): unknown;
}
