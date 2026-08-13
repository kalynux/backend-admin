/**
 * Print the authorization policy as a table.
 *
 * The grant table is code, which makes it reviewable in a diff but not easy to read as a
 * whole — `allInFamily()` expansions mean you cannot see a tier's real set by reading its
 * array. This prints the resolved answer.
 *
 * Reach for it when reviewing a policy change, when deciding what a level should hold, or
 * when someone asks "what can a Support administrator actually do".
 *
 *   npm run authz:matrix              the level→permission matrix
 *   npm run authz:matrix -- --flags   only the sensitive permissions and who holds them
 *
 * Needs no database and no Redis — the policy is static code.
 */
import { ADMIN_TIERS, ADMIN_TIER_LABELS } from '../src/modules/admin-identity/domain/admin-identity.types';
import { PERMISSION_NAMES, permissionSpec } from '../src/modules/authorization/domain/permission.catalog';
import { PERMISSION_FAMILIES } from '../src/modules/authorization/domain/permission.types';
import { grantedTo } from '../src/modules/authorization/domain/permission.resolver';
import { assertGrantTableValid } from '../src/modules/authorization/domain/tier-grants';
import { LEGACY_ENDPOINT_MAP } from '../src/modules/authorization/domain/legacy-endpoint-map';

function flagsOf(name: (typeof PERMISSION_NAMES)[number]): string {
    const spec = permissionSpec(name);
    const flags: string[] = [];
    if (spec.financial) flags.push('money');
    if (spec.escalation) flags.push('escalation');
    if (spec.destructive) flags.push('destructive');
    if (spec.dualControl) flags.push('4-eyes');
    if (spec.scope) flags.push(`scoped:${spec.scope}`);
    return flags.join(' ');
}

function main(): void {
    // Print the policy only if it is valid — a matrix from a broken table would be a
    // description of something that cannot run.
    assertGrantTableValid();

    const flagsOnly = process.argv.includes('--flags');

    console.log('\n━━━ Authorization matrix ━━━\n');
    console.log(`  ${PERMISSION_NAMES.length} permissions across ${PERMISSION_FAMILIES.length} families`);
    console.log(`  ${LEGACY_ENDPOINT_MAP.length} legacy endpoints still to port (Phase 5)\n`);

    for (const tier of ADMIN_TIERS) {
        console.log(`  Tier ${tier} — ${ADMIN_TIER_LABELS[tier]}: ${grantedTo(tier).size} permissions`);
    }

    console.log('\n  Legend: ● granted   · not granted');
    console.log(`\n  ${'permission'.padEnd(44)} ${'1'} ${'2'} ${'3'}  flags`);
    console.log(`  ${'─'.repeat(44)} ─ ─ ─  ─────`);

    for (const family of PERMISSION_FAMILIES) {
        const names = PERMISSION_NAMES.filter((name) => permissionSpec(name).family === family);
        const rows = flagsOnly ? names.filter((name) => flagsOf(name) !== '') : names;
        if (rows.length === 0) continue;

        console.log(`\n  ${family}`);
        for (const name of rows) {
            const marks = ADMIN_TIERS.map((tier) => (grantedTo(tier).has(name) ? '●' : '·')).join(' ');
            console.log(`  ${name.padEnd(44)} ${marks}  ${flagsOf(name)}`);
        }
    }

    console.log('\n━━━ end ━━━\n');
}

main();
