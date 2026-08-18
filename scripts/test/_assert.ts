/**
 * Shared assertion helper for the `scripts/test/` suites.
 *
 * Follows jovi-mall's testing convention — plain ts-node, hand-rolled asserts, no runner —
 * with one deviation: jovi-mall copy-pastes this helper into every test file, and the
 * copies have drifted. Extracting it stays inside the convention and removes that drift.
 *
 * Usage:
 *   const t = suite('foundation');
 *   t.assert('name', () => someBoolean);
 *   process.exit(t.finish());
 */

export interface Suite {
    assert(name: string, fn: () => boolean): void;
    section(title: string): void;
    /** Prints the tally and returns the intended process exit code (0 pass / 1 fail). */
    finish(): number;
}

export function suite(title: string): Suite {
    let passed = 0;
    let failed = 0;

    console.log(`\n━━━ ${title} ━━━`);

    return {
        section(sectionTitle: string): void {
            console.log(`\n  ${sectionTitle}`);
        },

        assert(name: string, fn: () => boolean): void {
            let ok: boolean;
            try {
                ok = fn();
            } catch (err) {
                console.error(`    ❌ THROW: ${name} — ${(err as Error).message}`);
                failed++;
                return;
            }

            /**
             * An `async` assertion returns a Promise, and a Promise is truthy — so it would
             * pass unconditionally, forever, whatever it actually checks. A test that cannot
             * fail is worse than no test: it reports the thing it was written to catch as
             * verified.
             *
             * The suites are deliberately synchronous (`await` first, assert on the result),
             * and the `verify:*` scripts all follow that. This makes the deviation loud
             * rather than invisible, because the failure has no other symptom.
             */
            if (ok !== null && typeof (ok as unknown as { then?: unknown })?.then === 'function') {
                console.error(
                    `    ❌ THROW: ${name} — assertion returned a Promise. `
                    + 'Await the value first and assert on the result; an async assertion always passes.',
                );
                failed++;
                return;
            }

            if (ok) {
                console.log(`    ✅ ${name}`);
                passed++;
            } else {
                console.error(`    ❌ FAIL: ${name}`);
                failed++;
            }
        },

        finish(): number {
            const total = passed + failed;
            console.log(`\n━━━ ${title}: ${passed}/${total} passed${failed ? `, ${failed} FAILED` : ''} ━━━\n`);
            return failed === 0 ? 0 : 1;
        },
    };
}

/** True when `fn` throws. Several foundation rules are "this must be refused". */
export function throws(fn: () => unknown): boolean {
    try {
        fn();
        return false;
    } catch {
        return true;
    }
}
