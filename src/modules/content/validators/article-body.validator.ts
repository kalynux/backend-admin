import { z } from 'zod';
import { CONTENT_LOCALES } from '../domain/content.types';

/**
 * The article body vocabulary — a typed block array, never an HTML string.
 *
 * ## Why this file is the security boundary
 *
 * An HTML string from an editor has to be sanitised on the way in and rendered with
 * `dangerouslySetInnerHTML` on the way out; one missed edge case is stored XSS on the
 * marketing domain, which is the same origin as the auth pages. A block array renders
 * through React components that cannot emit markup nobody asked for by name — so the
 * *only* thing standing between an editor and the published page is this schema. It is
 * therefore deliberately **strict** (`.strict()` everywhere: an unknown key is a 400, not
 * a silently dropped field) and deliberately **flat** (spans do not nest).
 *
 * ## Why it lives here now, and what that obliges
 *
 * Ownership of `articles` moved to this service at Phase 5 Part A (ADR-004 D-4), and this
 * service is the only writer. jovi-mall stores the body as Mongoose `Mixed` and its public
 * reader serves it back verbatim — **it validates nothing**. So this schema is not one of
 * two gates; it is the only one, for a payload that renders on a public marketing page.
 *
 * jovi-mall keeps a copy of this file for the `ArticleBody` *type* its public DTO needs.
 * The two are kept honest by fixture, not by import: `test:content` here and `test:blog`
 * there run the SAME accept/reject list. See `content.types.ts` for why there is no shared
 * package.
 *
 * ## Adding a block type
 *
 * Adding one here is not enough — `ArticleBody.tsx` on the frontend switches exhaustively
 * over the union, so an unknown `type` is a compile error there rather than a blank space
 * on a live page. It is now a **three**-repo change: here, jovi-mall's type copy, and the
 * marketing site.
 */

// ─── Links ───────────────────────────────────────────────────────────────────

/** `/fr/pricing`, `/en/faq`… — the mistake this rule exists to catch. */
const LOCALE_PREFIXED = new RegExp(`^/(${CONTENT_LOCALES.join('|')})(/|$)`);

/**
 * Every `href` an author can write, in a body or a CTA.
 *
 * **Internal links carry no locale prefix.** Write `/pricing`, not `/fr/pricing` — the
 * renderer localizes it, so a prefixed path renders as `/fr/fr/pricing`. That is a broken
 * link on a published page and it is invisible in the editor, which is exactly why it is
 * refused here rather than left to review.
 *
 * Anything starting `http(s)://` is external and the renderer gives it
 * `rel="nofollow noopener noreferrer"` + `target="_blank"`. Fragments (`#some-heading`) are
 * allowed so an author can link into their own article; `mailto:` is allowed for a contact
 * link. Everything else — `javascript:`, `data:`, protocol-relative `//evil.example`, a
 * bare `pricing` — is refused.
 */
export const HrefSchema = z
    .string()
    .trim()
    .min(1, 'A link needs an href')
    .max(2048)
    .refine(
        (href) =>
            /^https?:\/\//i.test(href)
            || /^mailto:/i.test(href)
            || href.startsWith('#')
            || (href.startsWith('/') && !href.startsWith('//')),
        'href must be an internal path starting with "/", a "#fragment", a mailto: address, or an http(s):// URL',
    )
    .refine(
        (href) => !LOCALE_PREFIXED.test(href),
        'Internal links must not carry a locale prefix — write "/pricing", not "/fr/pricing". The renderer localizes it.',
    );

// ─── Rich text ───────────────────────────────────────────────────────────────

/** Marks compose on one span; there is no nesting. */
const markFields = {
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    code: z.boolean().optional(),
};

const TextSpanSchema = z
    .object({ type: z.literal('text'), text: z.string().min(1), ...markFields })
    .strict();

const LinkSpanSchema = z
    .object({ type: z.literal('link'), text: z.string().min(1), href: HrefSchema, ...markFields })
    .strict();

/**
 * A flat array of inline spans. Not trimmed: `"Commission is taken "` and its trailing
 * space is meaningful — the spans are concatenated by the renderer, and trimming them would
 * jam the words either side of a bold run together.
 */
export const RichTextSchema = z
    .array(z.discriminatedUnion('type', [TextSpanSchema, LinkSpanSchema]))
    .min(1, 'Rich text needs at least one span');

export type RichText = z.infer<typeof RichTextSchema>;

// ─── Blocks ──────────────────────────────────────────────────────────────────

/**
 * `heading.id` is **authored, never derived from the text.**
 *
 * Deriving it means every anchor breaks the moment a title is edited or retranslated,
 * silently killing any link anyone shared into the middle of an article — and nothing
 * reports it, because the page still renders.
 */
const HeadingIdSchema = z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        'Heading ids are lowercase, digits and single hyphens (e.g. "how-momo-payouts-work")',
    );

const ImageUrlSchema = z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine(
        (url) => /^https?:\/\//i.test(url) || (url.startsWith('/') && !url.startsWith('//')),
        'An image url must be an http(s):// URL or an internal path starting with "/"',
    );

const HeadingBlockSchema = z
    .object({
        type: z.literal('heading'),
        level: z.union([z.literal(2), z.literal(3)]),
        id: HeadingIdSchema,
        text: z.string().trim().min(1).max(300),
    })
    .strict();

const ParagraphBlockSchema = z
    .object({ type: z.literal('paragraph'), text: RichTextSchema })
    .strict();

const ListBlockSchema = z
    .object({
        type: z.literal('list'),
        ordered: z.boolean().optional(),
        items: z.array(RichTextSchema).min(1, 'A list needs at least one item'),
    })
    .strict();

const QuoteBlockSchema = z
    .object({
        type: z.literal('quote'),
        text: z.string().trim().min(1).max(2000),
        attribution: z.string().trim().min(1).max(200).optional(),
    })
    .strict();

const CalloutBlockSchema = z
    .object({
        type: z.literal('callout'),
        tone: z.enum(['note', 'tip', 'warning']),
        title: z.string().trim().min(1).max(200).optional(),
        text: RichTextSchema,
    })
    .strict();

/**
 * `width` and `height` are **required**, and that is not pedantry: they reserve the box so
 * a loading image does not shift the paragraph under it. Layout shift is a Core Web Vitals
 * penalty, and it lands on exactly the pages that exist to rank.
 */
const ImageBlockSchema = z
    .object({
        type: z.literal('image'),
        url: ImageUrlSchema,
        alt: z.string().trim().min(1, 'Every image needs alt text').max(300),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        caption: z.string().trim().min(1).max(300).optional(),
    })
    .strict();

const CtaBlockSchema = z
    .object({
        type: z.literal('cta'),
        title: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(600),
        href: HrefSchema,
        label: z.string().trim().min(1).max(80),
    })
    .strict();

/** Renders as an accordion *and* as `FAQPage` structured data — hence plain text answers. */
const FaqBlockSchema = z
    .object({
        type: z.literal('faq'),
        items: z
            .array(
                z
                    .object({
                        question: z.string().trim().min(1).max(300),
                        answer: z.string().trim().min(1).max(2000),
                    })
                    .strict(),
            )
            .min(1, 'An FAQ block needs at least one question'),
    })
    .strict();

const DividerBlockSchema = z.object({ type: z.literal('divider') }).strict();

export const ArticleBlockSchema = z.discriminatedUnion('type', [
    HeadingBlockSchema,
    ParagraphBlockSchema,
    ListBlockSchema,
    QuoteBlockSchema,
    CalloutBlockSchema,
    ImageBlockSchema,
    CtaBlockSchema,
    FaqBlockSchema,
    DividerBlockSchema,
]);

export type ArticleBlock = z.infer<typeof ArticleBlockSchema>;

/**
 * A whole body.
 *
 * The one cross-block rule: **heading ids are unique within a body.** Two `#pricing`
 * anchors mean one of them is unreachable, and which one wins is a browser detail.
 */
export const ArticleBodySchema = z
    .array(ArticleBlockSchema)
    .min(1, 'An article body needs at least one block')
    .max(400)
    .superRefine((blocks, ctx) => {
        const seen = new Map<string, number>();
        blocks.forEach((block, index) => {
            if (block.type !== 'heading') return;
            const first = seen.get(block.id);
            if (first !== undefined) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: [index, 'id'],
                    message: `Duplicate heading id "${block.id}" (already used by block ${first}). Ids must be unique within a body.`,
                });
                return;
            }
            seen.set(block.id, index);
        });
    });

export type ArticleBody = z.infer<typeof ArticleBodySchema>;

// ─── Derivations ─────────────────────────────────────────────────────────────

/**
 * Spans concatenate with **no separator** — they are one sentence split at its formatting
 * boundaries, so `"Commission is taken "` + `"at payment"` is one run of prose. Joining them
 * with a space instead would turn a punctuation-only span like `"."` into its own token and
 * inflate every word count by roughly the number of bold runs in the article.
 */
function runText(spans: RichText): string {
    return spans.map((span) => span.text).join('');
}

/** Every human-readable *run* in a block, in reading order. */
function blockText(block: ArticleBlock): string[] {
    switch (block.type) {
        case 'heading':
            return [block.text];
        case 'paragraph':
            return [runText(block.text)];
        case 'list':
            return block.items.map(runText);
        case 'quote':
            return block.attribution ? [block.text, block.attribution] : [block.text];
        case 'callout':
            return [...(block.title ? [block.title] : []), runText(block.text)];
        case 'image':
            return block.caption ? [block.caption] : [];
        case 'cta':
            return [block.title, block.body, block.label];
        case 'faq':
            return block.items.flatMap((item) => [item.question, item.answer]);
        case 'divider':
            return [];
    }
}

/**
 * Words in a body, for the `wordCount` the article's structured data carries.
 *
 * **One of the three derivations that must not be lost in the port** (Phase 5 plan A.1,
 * Phase 17 register C-6). Computed here rather than accepted from the editor so it cannot
 * drift from the prose after a revision — the same reason `readingMinutes` is *not* sent at
 * all and is derived on the frontend from the body it is about to render.
 *
 * Image `alt` is the one omission — it is an accessibility label, not prose the reader is
 * spending time on. Everything else that renders as visible text counts, CTA copy included.
 */
export function countWords(body: ArticleBody): number {
    const text = body.flatMap(blockText).join(' ');
    const words = text.trim().match(/\S+/g);
    return words ? words.length : 0;
}

/** Every heading id in a body, in order — the table of contents, recoverable because blocks are typed. */
export function headingIds(body: ArticleBody): string[] {
    return body
        .filter((block): block is Extract<ArticleBlock, { type: 'heading' }> => block.type === 'heading')
        .map((block) => block.id);
}
