import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Carried over from jovi-mall: the two `no-restricted-syntax` bans are a real
 * platform convention, not style preference. `createAppError()` keeps every error
 * inside the machine-readable code registry, and `next(error)` keeps every response
 * inside the one documented envelope.
 *
 * Two deliberate divergences from jovi-mall's config: `no-unused-vars` stays ON
 * (jovi-mall disables it, which is how three dead admin code paths went unnoticed —
 * see PHASE-0-DISCOVERY.md), and `no-explicit-any` is a warning rather than off.
 */
export default tseslint.config(
    {
        // `scripts/**` left this list in plan step 0.C. It held the 18 suites, the live
        // verifiers and the bootstrap, and it was checked by NOTHING — not this config and
        // not tsconfig.json, whose `include` is `src/**/*`. The proof was already in the
        // tree: `scripts/test/verify-audit-live.ts` had not compiled since Phase 12 gave
        // the audit export its own actor, and no command in this repository said so.
        ignores: ['dist/**'],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector: "ThrowStatement > NewExpression[callee.name='Error']",
                    message: 'Use createAppError() or an AppError subclass instead of throw new Error()',
                },
                {
                    selector: "CallExpression[callee.property.name='json'][arguments.0.properties.0.key.name='error']",
                    message: 'Use next(error) instead of res.status().json({ error: ... }). Let the global handler respond.',
                },
            ],
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        },
    },
    {
        // The bootstrap and the global error handler are the two places allowed to
        // build a response by hand — the handler *is* the envelope, and the bootstrap
        // runs before the handler is mounted.
        files: ['src/app.ts', 'src/server.ts', 'src/api/middlewares/error-handler.middleware.ts'],
        rules: {
            'no-restricted-syntax': 'off',
        },
    },
    {
        files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
        rules: {
            'no-restricted-syntax': 'off',
        },
    },
    {
        // scripts/ — the suites, the live verifiers and the bootstrap CLI.
        //
        // `throw new Error()` is correct here and the ban is switched off for it alone.
        // That ban exists because a throw in `src/` escapes the code registry and the
        // response envelope; a CLI that aborts has neither. The `res.json({ error })`
        // selector is re-stated rather than dropped — it cannot fire in a script today,
        // and it should still fire if one ever builds a response by hand.
        files: ['scripts/**/*.ts'],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector: "CallExpression[callee.property.name='json'][arguments.0.properties.0.key.name='error']",
                    message: 'Use next(error) instead of res.status().json({ error: ... }). Let the global handler respond.',
                },
            ],

            // `any` is a fixture's natural type here. These suites build malformed inputs on
            // purpose and read HTTP bodies whose shape is what they are asserting — typing
            // those precisely would mean asserting the shape twice, once in the type and once
            // in the test, and the type would win silently. It stays a WARNING in src/, which
            // is the divergence from jovi-mall this config's header describes.
            '@typescript-eslint/no-explicit-any': 'off',

            // A lazy `require()` is deliberate in this tree: several suites load a module
            // AFTER arranging state, or read a source file with `require('fs')` to scan it.
            // A top-level import would run module initialisation at the wrong moment, which
            // is precisely what a boot-order or source-scan assertion exists to control.
            '@typescript-eslint/no-require-imports': 'off',
        },
    },
);
