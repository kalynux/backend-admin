/**
 * Bootstrap the first administrator.
 *
 * This is the ONLY way an administrator comes into existence. Self-registration is gone
 * from both services: jovi-mall's register/add-role no longer accept `admin` (Phase 0.5,
 * where they were an unauthenticated path to a platform administrator), and this service
 * has no public sign-up at all.
 *
 * Two safety properties:
 *
 *  - **Idempotent.** Refuses once ANY administrator exists. Re-running it cannot mint a
 *    second superuser or reset an existing one's password — an "idempotent" bootstrap
 *    that silently overwrote credentials would be a backdoor.
 *  - **The password is generated and shown once.** Nothing is written to a file or a
 *    log, and the logger redacts credential-shaped fields anyway.
 *
 * ── Narrowed in Phase 3 ───────────────────────────────────────────────────────
 * This used to refuse only a second TIER-1 administrator, so `--tier 2` and `--tier 3`
 * remained creatable from a shell forever. That was a standing out-of-band path into the
 * service: an account created that way has no creator recorded, and it bypasses every
 * rule in `escalation.rules.ts` — including the one that stops an Admin from minting a
 * peer.
 *
 * There is now an API for this (`POST /api/v1/administrators`), so the CLI is restricted
 * to what only it can do: bring the FIRST administrator into existence, when there is
 * nobody to authenticate as. `--tier` is gone with it; the first administrator is a
 * Developer, because nothing less can grant anything.
 *
 * Usage:
 *   npm run bootstrap:admin -- --email ops@example.com --name "Ops Lead"
 *   npm run bootstrap:admin -- --email ops@example.com --name "Ops Lead" --password '...'
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { env } from '../src/config/env';
import { connectAll, closeAll } from '../src/infra/mongo/connections';
import { closeRedisClients } from '../src/infra/redis/redis.factory';
import { AdminAccountRepository } from '../src/modules/admin-identity/repositories/admin-account.repository';
import { hash, generateStrongPassword, checkPasswordPolicy } from '../src/modules/admin-identity/domain/password.service';
import { AdminTier, ADMIN_TIER_LABELS } from '../src/modules/admin-identity/domain/admin-identity.types';
import { mfaRequiredForTier } from '../src/modules/admin-identity/domain/mfa.service';
import { auditedTransaction } from '../src/modules/audit/domain/audit.writer';

/** The first administrator is always a Developer — see the header. */
const BOOTSTRAP_TIER: AdminTier = 1;

interface Args {
    email?: string;
    name?: string;
    password?: string;
}

function parseArgs(argv: string[]): Args {
    const out: Args = {};
    for (let i = 0; i < argv.length; i++) {
        const [flag, inlineValue] = argv[i].split('=', 2);
        const value = inlineValue ?? argv[++i];
        switch (flag) {
            case '--email': out.email = value?.trim().toLowerCase(); break;
            case '--name': out.name = value?.trim(); break;
            case '--password': out.password = value; break;
            case '--tier':
                // Refused rather than ignored: silently creating a Developer for someone
                // who asked for a Support account is worse than telling them no.
                usage(
                    '--tier is no longer accepted. The bootstrap creates the first Developer only; ' +
                    'create every other administrator through POST /api/v1/administrators.',
                );
                break;
        }
    }
    return out;
}

function usage(message: string): never {
    process.stderr.write(
        `\n[bootstrap] ${message}\n\n` +
        `  npm run bootstrap:admin -- --email <address> --name "<display name>" [--password <pw>]\n\n`,
    );
    process.exit(1);
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    if (!args.email) usage('--email is required');
    if (!args.name) usage('--name is required');

    // Validates configuration before touching anything, and fails closed on a bad env.
    env();
    await connectAll();

    const accounts = new AdminAccountRepository();

    // The refusal that makes this safe to leave in a deploy pipeline — and, since Phase 3,
    // the refusal that keeps this from being a standing side door. ANY existing
    // administrator means there is someone to authenticate as, so the API is the way.
    const existing = await accounts.countAll();
    if (existing > 0) {
        process.stderr.write(
            `\n[bootstrap] Refusing: ${existing} administrator(s) already exist.\n` +
            `            Bootstrap creates the FIRST administrator only. Create every other\n` +
            `            account through POST /api/v1/administrators, which records who\n` +
            `            created it and enforces the level rules this script cannot.\n\n`,
        );
        process.exit(1);
    }

    if (await accounts.findByEmail(args.email)) {
        process.stderr.write(`\n[bootstrap] Refusing: an administrator with ${args.email} already exists.\n\n`);
        process.exit(1);
    }

    const password = args.password ?? generateStrongPassword();
    const policy = checkPasswordPolicy(password);
    if (!policy.ok) {
        usage(`the supplied password ${policy.problems.join(', ')}`);
    }

    const passwordHash = await hash(password);

    // Through the audit writer, like every other administrator creation — the first
    // account is the one whose provenance matters most, and it is the only one with no
    // `created_by` to fall back on. `actor_kind: 'system'` says a CLI did it, not a person,
    // and the row is committed in the same transaction as the account itself.
    const admin = await auditedTransaction(
        {
            action: 'administrators.create',
            actor: {
                kind: 'system',
                id: null,
                email: null,
                displayName: 'bootstrap CLI',
                tier: null,
                sessionId: null,
            },
            target: { type: 'administrator', id: null, label: args.email },
            context: {
                method: 'CLI',
                path: 'npm run bootstrap:admin',
                requestId: randomUUID(),
                ip: null,
                userAgent: null,
            },
            payload: { email: args.email, displayName: args.name, tier: BOOTSTRAP_TIER },
        },
        async (session) => {
            const created = await accounts.create({
                email: args.email,
                displayName: args.name,
                passwordHash,
                tier: BOOTSTRAP_TIER,
                // No creator, and the only account for which that is true. Every
                // administrator made through the API records who made them.
                createdBy: null,
            }, session);

            return {
                result: created,
                target: { id: created._id.toString(), label: created.email },
                after: { email: created.email, displayName: created.display_name, tier: created.tier },
            };
        },
    );

    const generated = !args.password;
    process.stdout.write(
        `\n[bootstrap] Administrator created.\n\n` +
        `  id     ${admin._id.toString()}\n` +
        `  email  ${admin.email}\n` +
        `  name   ${admin.display_name}\n` +
        `  tier   ${admin.tier} (${ADMIN_TIER_LABELS[admin.tier]})\n` +
        (generated ? `\n  PASSWORD (shown once, not stored anywhere else):\n\n      ${password}\n` : '') +
        (mfaRequiredForTier(admin.tier)
            ? `\n  ⚠ Tier ${admin.tier} REQUIRES two-factor authentication.\n` +
              `    First sign-in returns a SCOPED session that can only reach:\n` +
              `      POST /api/v1/auth/mfa/enroll    → scan the QR / copy the secret\n` +
              `      POST /api/v1/auth/mfa/activate  → confirm with a 6-digit code\n` +
              `    then sign in again. Every other endpoint is refused until then.\n`
            : '') +
        `\n`,
    );
}

main()
    .then(async () => {
        await closeAll();
        await closeRedisClients();
        process.exit(0);
    })
    .catch(async (error) => {
        process.stderr.write(`\n[bootstrap] failed: ${error instanceof Error ? error.message : String(error)}\n\n`);
        await closeAll().catch(() => undefined);
        await closeRedisClients().catch(() => undefined);
        process.exit(1);
    });
