import { AsyncLocalStorage } from 'async_hooks';

/**
 * Did this request actually write the row it promised?
 *
 * ── What this is, and what it is emphatically not ─────────────────────────────
 * A **smoke detector**. The `audit:` declaration on a route is a promise checked three ways
 * (the type, the boot assertion, the source scan), and all three check the DECLARATION.
 * None of them can see whether the writer was reached — the call sits deep in a service or
 * a gateway, and a handler can return 200 having recorded nothing.
 *
 * This closes that last gap by observation: the probe opens a scope per mutating request,
 * the writer marks what it emitted, and the probe compares on `finish`.
 *
 * **It must never change a response, and it must never fail a request.** By the time it can
 * know the answer, the status is already sent — so the only honest thing it can do is
 * complain loudly into the log. Making it a lock would mean either buffering every response
 * (to be able to retract one) or refusing writes that already happened, and both are worse
 * than the problem.
 *
 * ── Why AsyncLocalStorage rather than a Map keyed by requestId ────────────────
 * A `Map<requestId, Set<action>>` would need clearing on both `finish` and `close`, and a
 * missed `close` is a leak that grows for the life of the process. ALS is scoped by
 * construction: when the async context ends the store is unreachable, whether the response
 * finished, errored or was aborted.
 */

const emissions = new AsyncLocalStorage<Set<string>>();

/** Run `fn` inside a fresh emission scope. Called by the route probe, once per request. */
export function withEmissionScope<T>(fn: () => T): T {
    return emissions.run(new Set<string>(), fn);
}

/**
 * Mark an action as emitted on this request.
 *
 * Called by the writer's entry points. A no-op outside a scope, which is the common case —
 * background sweeps, the CLI and the boot-time resume all write rows with no request around
 * them, and none of that is an error.
 */
export function noteEmission(action: string): void {
    emissions.getStore()?.add(action);
}

/** What was emitted so far on this request, or null when called outside a scope. */
export function emittedInScope(): ReadonlySet<string> | null {
    return emissions.getStore() ?? null;
}
