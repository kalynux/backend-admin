import { z } from 'zod';

/**
 * `POST /api/v1/accounts/:ownerType/:ownerId/statements` body.
 *
 * `.strict()` so a `to`/`email` field is a 400 rather than silently ignored: the recipient is
 * never the caller's to choose (O-6). `from`/`to` are local calendar DAYS, both inclusive; the
 * range rules (order, ≤ 366 days, real dates) live in `toStatementPeriod`, the one place the
 * period is interpreted.
 */
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

export const CreateStatementBodySchema = z
    .object({
        from: Day,
        to: Day,
        format: z.enum(['xlsx', 'pdf']),
        delivery: z.enum(['download', 'email']),
    })
    .strict();

export type CreateStatementBody = z.infer<typeof CreateStatementBodySchema>;
