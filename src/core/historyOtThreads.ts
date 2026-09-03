/* eslint-disable @typescript-eslint/naming-convention */
import {deepCloneJson} from './historyOt/protocol';
import type {JsonObject, JsonValue} from './historyOt/types';
import type {HistoryOtRawThreadEvent, HistoryOtThreadEventName} from './historyOtSession';

export class HistoryOtThreadEventError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'HistoryOtThreadEventError';
    }
}

function isObject(input: JsonValue | undefined): input is JsonObject {
    return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function object(input: JsonValue | undefined, label: string): JsonObject {
    if (!isObject(input)) {
        throw new HistoryOtThreadEventError(`${label} must be a JSON object`);
    }
    return input;
}

function nonEmptyString(input: JsonValue | undefined, label: string): string {
    if (typeof input !== 'string' || input.length === 0) {
        throw new HistoryOtThreadEventError(`${label} must be a non-empty string`);
    }
    return input;
}

function stringValue(input: JsonValue | undefined, label: string): string {
    if (typeof input !== 'string') {
        throw new HistoryOtThreadEventError(`${label} must be a string`);
    }
    return input;
}

function messageArray(thread: JsonObject, label: string): JsonValue[] {
    const messages = thread.messages;
    if (messages === undefined) { return []; }
    if (!Array.isArray(messages) || !messages.every(isObject)) {
        throw new HistoryOtThreadEventError(`${label}.messages must be an array of JSON objects`);
    }
    return messages;
}

function cloneDirectory(input: JsonValue | undefined): JsonObject {
    if (input === undefined) { return {}; }
    return object(deepCloneJson(input), 'comment thread directory');
}

function cloneThread(directory: JsonObject, threadId: string): JsonObject {
    const raw = directory[threadId];
    return raw === undefined ? {messages: []} : object(deepCloneJson(raw), `thread ${threadId}`);
}

function validateThreadId(args: readonly JsonValue[], event: HistoryOtThreadEventName): string {
    return nonEmptyString(args[0], `${event} thread id`);
}

/**
 * Apply one official review-panel socket event while preserving every unknown
 * JSON field on the directory, thread, and message objects. The raw append-only
 * event log remains the protocol record; this reducer is only the live hover
 * projection consumed by the current editor UI.
 */
export function reduceHistoryOtThreadEvent(
    input: JsonValue | undefined,
    rawEvent: HistoryOtRawThreadEvent,
    resolveTimestamp: () => string = () => new Date().toISOString(),
): JsonObject {
    const directory = cloneDirectory(input);
    const args = deepCloneJson(rawEvent.args) as JsonValue[];
    const event = rawEvent.event;

    switch (event) {
        case 'new-comment': {
            if (args.length !== 2) {
                throw new HistoryOtThreadEventError('new-comment requires two arguments');
            }
            const threadId = validateThreadId(args, event);
            const comment = object(args[1], 'new-comment message');
            nonEmptyString(comment.id, 'new-comment message id');
            if (typeof comment.timestamp !== 'number' || !Number.isFinite(comment.timestamp)) {
                throw new HistoryOtThreadEventError('new-comment timestamp must be a finite number');
            }
            const thread = cloneThread(directory, threadId);
            const {submitting: _submitting, ...stableThread} = thread;
            directory[threadId] = {
                ...stableThread,
                messages: [...messageArray(thread, `thread ${threadId}`), deepCloneJson(comment)],
            };
            return directory;
        }
        case 'edit-message': {
            if (args.length !== 3) {
                throw new HistoryOtThreadEventError('edit-message requires three arguments');
            }
            const threadId = validateThreadId(args, event);
            const commentId = nonEmptyString(args[1], 'edit-message comment id');
            const content = stringValue(args[2], 'edit-message content');
            const thread = cloneThread(directory, threadId);
            directory[threadId] = {
                ...thread,
                messages: messageArray(thread, `thread ${threadId}`).map(message => {
                    const record = object(message, `thread ${threadId} message`);
                    return record.id === commentId ? {...record, content} : record;
                }),
            };
            return directory;
        }
        case 'delete-message': {
            if (args.length !== 2) {
                throw new HistoryOtThreadEventError('delete-message requires two arguments');
            }
            const threadId = validateThreadId(args, event);
            const commentId = nonEmptyString(args[1], 'delete-message comment id');
            const thread = cloneThread(directory, threadId);
            directory[threadId] = {
                ...thread,
                messages: messageArray(thread, `thread ${threadId}`).filter(message =>
                    object(message, `thread ${threadId} message`).id !== commentId),
            };
            return directory;
        }
        case 'resolve-thread': {
            if (args.length !== 2) {
                throw new HistoryOtThreadEventError('resolve-thread requires two arguments');
            }
            const threadId = validateThreadId(args, event);
            const user = object(args[1], 'resolve-thread user');
            nonEmptyString(user.id, 'resolve-thread user id');
            const thread = cloneThread(directory, threadId);
            directory[threadId] = {
                ...thread,
                resolved: true,
                resolved_by_user: user,
                resolved_at: nonEmptyString(resolveTimestamp(), 'resolve-thread timestamp'),
            };
            return directory;
        }
        case 'reopen-thread': {
            if (args.length !== 1) {
                throw new HistoryOtThreadEventError('reopen-thread requires one argument');
            }
            const threadId = validateThreadId(args, event);
            const thread = cloneThread(directory, threadId);
            delete thread.resolved;
            delete thread.resolved_at;
            delete thread.resolved_by_user;
            delete thread.resolved_by_user_id;
            directory[threadId] = thread;
            return directory;
        }
        case 'delete-thread': {
            if (args.length !== 1) {
                throw new HistoryOtThreadEventError('delete-thread requires one argument');
            }
            delete directory[validateThreadId(args, event)];
            return directory;
        }
        case 'new-comment-threads': {
            if (args.length !== 1) {
                throw new HistoryOtThreadEventError('new-comment-threads requires one argument');
            }
            const incoming = object(args[0], 'new-comment-threads directory');
            for (const [threadId, value] of Object.entries(incoming)) {
                nonEmptyString(threadId, 'new-comment-threads thread id');
                const thread = object(value, `new-comment-threads thread ${threadId}`);
                messageArray(thread, `new-comment-threads thread ${threadId}`);
                const previous = directory[threadId];
                directory[threadId] = {
                    ...(isObject(previous) ? previous : {}),
                    ...deepCloneJson(thread) as JsonObject,
                };
            }
            return directory;
        }
        default: {
            const exhaustive: never = event;
            throw new HistoryOtThreadEventError(`Unsupported History OT thread event ${exhaustive}`);
        }
    }
}

export function reduceHistoryOtThreadEvents(
    input: JsonValue | undefined,
    events: readonly HistoryOtRawThreadEvent[],
    resolveTimestamp: () => string = () => new Date().toISOString(),
): JsonObject {
    return events.reduce<JsonObject>(
        (state, event) => reduceHistoryOtThreadEvent(state, event, resolveTimestamp),
        cloneDirectory(input),
    );
}
