import { AdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { AdminAuthorStamp } from './article.document';

/**
 * Who wrote this article, as an **internal** record.
 *
 * ── The rule this file exists to keep ─────────────────────────────────────────
 * Phase 17 plan § 3.4: the editorial **byline** (`article_authors` — what
 * `content.authors.*` manages, what the public site renders, what becomes the `author` node
 * of the `BlogPosting` structured data) and the **administrative author** (which
 * administrator wrote it) are two concepts, and **merging them publishes staff identity on
 * a marketing page**. They are two different shapes in two different files for that reason,
 * and `read-models/public-article.dto.ts` reads neither `created_by_admin` nor
 * `updated_by_admin`.
 *
 * ── Why it is built from the SESSION, not from `admin_accounts` ───────────────
 * The ticket snapshot (`support/domain/admin-snapshot.ts`) reads the account row, because
 * it carries a job title and a department and is shown **to a customer** — jovi-mall cannot
 * look a wi-admin administrator up, so the copy on the ticket is the only record there will
 * ever be.
 *
 * This stamp is never shown to anybody outside this service, so it needs neither of those
 * fields, and the request's own identity already carries the two it does need. Paying an
 * `admin_accounts` read per article write for a value nobody reads would be cost without a
 * reason.
 *
 * ── What it is NOT ────────────────────────────────────────────────────────────
 * Not an audit row. The audit trail records the act (`content.articles.update`, with actor,
 * tier, session and correlation id); this records the **current state** of "whose article is
 * this" for an editor looking at a list, and it is overwritten on every write. If you want
 * the history, read the audit feed — that is what it is for.
 */
export function adminAuthorStampOf(identity: AdminIdentity): AdminAuthorStamp {
    return {
        id: identity.adminId,
        // Constant, not read from anywhere: only a wi-admin administrator can reach this
        // surface. The field exists so the stored shape can distinguish a legacy jovi-mall
        // `admins` row if one ever appeared, exactly as the ticket snapshot's does.
        source: 'admin',
        name: identity.displayName,
        tier: identity.tier,
    };
}
