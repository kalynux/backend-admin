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
        ignores: ['dist/**', 'scripts/**'],
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
);
