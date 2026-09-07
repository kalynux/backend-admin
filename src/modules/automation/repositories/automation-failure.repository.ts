import { createHash } from 'crypto';
import { FilterQuery } from 'mongoose';
import { env } from '../../../config/env';
import { AutomationFailureModel, IAutomationFailure } from '../models/automation-failure.model';
import { AutomationChannel, AutomationFailureKind, AutomationFailureRecord } from '../domain/automation.types';

const MS_PER_DAY = 86_400_000;

/**
 * How long a single message or stack may be. n8n stack traces run to kilobytes and the
 * value is attacker-adjacent only in the sense that a misbehaving node could emit a very
 * large one; the cap keeps one bad workflow from filling the collection.
 */
const MAX_MESSAGE_CHARS = 2_000;
const MAX_STACK_CHARS = 8_000;

export interface RecordFailureInput {
    workflowId: string;
    workflowName: string | null;
    executionId: string | null;
    kind: AutomationFailureKind;
    occurredAt: Date;
    nodeName: string | null;
    errorMessage: string | null;
    errorStack: string | null;
    channel: AutomationChannel;
    /** The RAW identifier. Hashed here and never stored — see the model header. */
    externalId: string | null;
    requestId: string | null;
}

export interface FailureQuery {
    workflowId?: string;
    kind?: AutomationFailureKind;
    channel?: AutomationChannel;
    since?: Date;
    limit: number;
}

/**
 * The digest stored in place of a customer's chat id or phone number.
 *
 * Salted with the report token, which is already a per-deployment secret this service
 * holds. An unsalted sha256 of a phone number is reversible by anyone willing to hash the
 * number space, which for E.164 is small enough to be a weekend.
 */
function hashExternalId(externalId: string): string {
    const salt = env().AUTOMATION_REPORT_TOKEN ?? '';
    return createHash('sha256').update(`${salt}:${externalId}`).digest('hex').slice(0, 32);
}

function truncate(value: string | null, max: number): string | null {
    if (value === null) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > max ? `${trimmed.slice(0, max)}…[truncated]` : trimmed;
}

function toRecord(doc: IAutomationFailure): AutomationFailureRecord {
    return {
        id: doc._id.toString(),
        workflowId: doc.workflow_id,
        workflowName: doc.workflow_name,
        executionId: doc.execution_id,
        kind: doc.kind,
        occurredAt: doc.occurred_at.toISOString(),
        receivedAt: doc.received_at.toISOString(),
        nodeName: doc.node_name,
        errorMessage: doc.error_message,
        errorStack: doc.error_stack,
        channel: doc.channel,
        externalIdHash: doc.external_id_hash,
        requestId: doc.request_id,
    };
}

export const AutomationFailureRepository = {
    /**
     * Store one report, or recognise it as one already stored.
     *
     * `upsert` rather than `insert` + catch: a duplicate is the EXPECTED outcome of an n8n
     * retry, not an error condition, and turning it into a 409 would make a reporter node
     * that is behaving correctly look broken. The caller learns which happened from
     * `duplicate`, so the response can say so without pretending nothing arrived.
     */
    async record(input: RecordFailureInput): Promise<{ id: string; duplicate: boolean }> {
        const purgeAfter = new Date(
            input.occurredAt.getTime() + env().ADMIN_AUTOMATION_RETENTION_DAYS * MS_PER_DAY,
        );

        const filter: FilterQuery<IAutomationFailure> = {
            workflow_id: input.workflowId,
            execution_id: input.executionId,
            kind: input.kind,
        };

        const existing = await AutomationFailureModel().findOne(filter).select('_id').lean();
        if (existing) {
            return { id: String(existing._id), duplicate: true };
        }

        const created = await AutomationFailureModel().create({
            workflow_id: input.workflowId,
            workflow_name: input.workflowName,
            execution_id: input.executionId,
            kind: input.kind,
            occurred_at: input.occurredAt,
            received_at: new Date(),
            node_name: input.nodeName,
            error_message: truncate(input.errorMessage, MAX_MESSAGE_CHARS),
            error_stack: truncate(input.errorStack, MAX_STACK_CHARS),
            channel: input.channel,
            external_id_hash: input.externalId ? hashExternalId(input.externalId) : null,
            request_id: input.requestId,
            purge_after: purgeAfter,
        });

        return { id: created._id.toString(), duplicate: false };
    },

    async list(query: FailureQuery): Promise<AutomationFailureRecord[]> {
        const filter: FilterQuery<IAutomationFailure> = {};
        if (query.workflowId) filter.workflow_id = query.workflowId;
        if (query.kind) filter.kind = query.kind;
        if (query.channel) filter.channel = query.channel;
        if (query.since) filter.occurred_at = { $gte: query.since };

        const docs = await AutomationFailureModel()
            .find(filter)
            .sort({ occurred_at: -1, _id: -1 })
            .limit(query.limit)
            .exec();

        return docs.map(toRecord);
    },

    /**
     * Counts by workflow and kind over a window, plus the distinct-customer count.
     *
     * The distinct count is computed HERE, server-side, because it is the one thing
     * `external_id_hash` is for and the hash itself never leaves the projection. "Forty
     * reports from one customer" and "forty reports from forty customers" are different
     * incidents, and a caller cannot tell them apart from a list.
     */
    async summary(since: Date): Promise<
        Array<{
            workflowId: string;
            workflowName: string | null;
            kind: AutomationFailureKind;
            channel: AutomationChannel;
            count: number;
            distinctCustomers: number;
            lastOccurredAt: string;
        }>
    > {
        const rows = await AutomationFailureModel().aggregate<{
            _id: { workflow_id: string; kind: AutomationFailureKind; channel: AutomationChannel };
            workflow_name: string | null;
            count: number;
            customers: (string | null)[];
            last: Date;
        }>([
            { $match: { occurred_at: { $gte: since } } },
            {
                $group: {
                    _id: { workflow_id: '$workflow_id', kind: '$kind', channel: '$channel' },
                    workflow_name: { $last: '$workflow_name' },
                    count: { $sum: 1 },
                    customers: { $addToSet: '$external_id_hash' },
                    last: { $max: '$occurred_at' },
                },
            },
            { $sort: { count: -1 } },
        ]);

        return rows.map((row) => ({
            workflowId: row._id.workflow_id,
            workflowName: row.workflow_name,
            kind: row._id.kind,
            channel: row._id.channel,
            count: row.count,
            distinctCustomers: row.customers.filter((hash) => hash !== null).length,
            lastOccurredAt: row.last.toISOString(),
        }));
    },
};
