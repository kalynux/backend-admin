import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { MessagingController } from '../controllers/messaging.controller';
import { SendTelegramMessageSchema } from '../validators/messaging.validator';

/**
 * `/api/v1/messaging` — one route, and it exists to get an admin-only capability off a
 * webhook path.
 *
 * ── Where it came from ───────────────────────────────────────────────────────
 * `POST /api/webhooks/telegram/send` was the **last** legacy admin endpoint anywhere, and
 * the last of three that lived outside `/api/admin` on public-looking prefixes (Phase 5
 * Part B took the two file ones). It was guarded by `requireRole(['admin'])` on a jovi-mall
 * `users` row — a credential that predates this service's permission catalog entirely and
 * carries no tier, so the tier matrix could not have been applied to it there. Porting it
 * takes `LEGACY_ENDPOINT_COUNT` to **0**.
 *
 * ── The family was renamed, and the rename is the substance ──────────────────
 * `broadcast` → `messaging`, `broadcast.send` → `messaging.telegram.send` (Phase 5 D-11).
 * Nothing here fans out: one message, one recipient, no audience, no segmentation, no
 * scheduling, and no delivery record to report on afterwards. The channel is in the
 * permission name because a second channel would be a second capability with its own
 * failure modes, not a parameter to this one.
 *
 * ── Tier 2, and audited with the body ────────────────────────────────────────
 * Neither `destructive` nor `sensitive`, so `allInFamily('messaging')` sweeps it into
 * Admin. That is right on grantability — it changes no record — but a send is the one thing
 * on this surface that is *already read* by the time anybody reconsiders it, and that is
 * answered by the audit rather than by a flag: the row carries the recipient and the full
 * message (Phase 5 O-2). See the gateway.
 *
 * ⚠ **The wire schema is narrower than jovi-mall's**, deliberately: EXACTLY one of
 * `userId` / `chatId`, where jovi-mall asks for at least one and then silently prefers the
 * chat. The validator says why the refusal belongs on this side.
 */
const router = Router();
const mountedAt = '/messaging';

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/telegram',
    access: permission('messaging.telegram.send'),
    validate: { body: SendTelegramMessageSchema },
    audit: records('messaging.telegram.send'),
    handler: MessagingController.sendTelegram,
});

export { router as messagingRoutes };
