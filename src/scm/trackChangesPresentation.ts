/* eslint-disable @typescript-eslint/naming-convention */
import {
    HistoryOtRange,
    HistoryOtSnapshotInput,
    JsonObject,
    JsonValue,
    StringFileDataSnapshot,
} from '../core/historyOt/types';
import {deepCloneJson, getSafeSnapshotRaw, HistoryOtProtocolError} from '../core/historyOt/protocol';
import {
    mapSnapshotOffsetToVisible,
    mapVisibleOffsetToSnapshot,
    visibleText,
} from '../core/historyOt/snapshot';

export const REALTIME_HISTORY_OT_PRESENTATION_KIND =
    'realtime-history-ot-track-changes-presentation-v1' as const;

export interface Utf16Position {
    readonly line: number,
    readonly character: number,
}

export interface Utf16LocatedOffset {
    readonly offset: number,
    readonly position: Utf16Position,
}

export interface Utf16LocatedRange {
    readonly startOffset: number,
    readonly endOffset: number,
    readonly start: Utf16Position,
    readonly end: Utf16Position,
}

export interface HistoryOtSnapshotRangeDescriptor extends Utf16LocatedRange {
    readonly pos: number,
    readonly length: number,
}

export interface HistoryOtMemberData {
    readonly id?: string,
    readonly _id?: string,
    readonly firstName?: string,
    readonly first_name?: string,
    readonly lastName?: string,
    readonly last_name?: string,
    readonly email?: string,
    /** A null directory entry is also accepted as an explicit deleted-user marker. */
    readonly deleted?: boolean,
}

export type HistoryOtMemberDirectory =
    | ReadonlyMap<string, HistoryOtMemberData | null>
    | Readonly<Record<string, HistoryOtMemberData | null | undefined>>;

export interface HistoryOtAuthorDescriptor {
    /** Always preserves the tracking user id, including unknown/deleted users. */
    readonly id: string,
    readonly status: 'known' | 'deleted' | 'unknown',
    readonly memberId?: string,
    readonly firstName?: string,
    readonly lastName?: string,
    readonly email?: string,
}

export interface HistoryOtVisibleBoundaryDescriptor {
    /** The single visible location to which one or more hidden deletions collapse. */
    readonly visible: Utf16LocatedOffset,
    /** Snapshot offsets selected by left/right affinity at the collapsed boundary. */
    readonly snapshotAffinity: {
        readonly left: Utf16LocatedOffset,
        readonly right: Utf16LocatedOffset,
    },
}

interface HistoryOtTrackedChangeDescriptorBase {
    readonly stableId: string,
    readonly authorId: string,
    readonly timestamp: string,
    readonly author: HistoryOtAuthorDescriptor,
    readonly snapshotRange: HistoryOtSnapshotRangeDescriptor,
}

export interface HistoryOtTrackedInsertionDescriptor
    extends HistoryOtTrackedChangeDescriptorBase {
    readonly kind: 'tracked-insertion',
    readonly insertedText: string,
    readonly visibleRange: Utf16LocatedRange,
}

export interface HistoryOtTrackedDeletionDescriptor
    extends HistoryOtTrackedChangeDescriptorBase {
    readonly kind: 'tracked-deletion',
    readonly deletedText: string,
    readonly visibleBoundary: HistoryOtVisibleBoundaryDescriptor,
}

export type HistoryOtTrackedChangeDescriptor =
    | HistoryOtTrackedInsertionDescriptor
    | HistoryOtTrackedDeletionDescriptor;

export interface HistoryOtRawRange {
    readonly pos: number,
    readonly length: number,
}

export type HistoryOtVisibleCommentAnchor =
    | {
        readonly kind: 'range',
        readonly range: Utf16LocatedRange,
    }
    | {
        readonly kind: 'boundary',
        readonly boundary: HistoryOtVisibleBoundaryDescriptor,
    };

export interface HistoryOtCommentRangeDescriptor {
    readonly stableId: string,
    readonly rawRange: HistoryOtRawRange,
    readonly snapshotRange: HistoryOtSnapshotRangeDescriptor,
    readonly visibleAnchor: HistoryOtVisibleCommentAnchor,
}

export interface HistoryOtCommentAnchorDescriptor {
    readonly kind: 'history-ot-comment-anchor',
    readonly stableId: string,
    readonly id: string,
    readonly resolved: boolean,
    /** Exact, ordered snapshot ranges, retained separately from mapped anchors. */
    readonly rawRanges: readonly HistoryOtRawRange[],
    readonly ranges: readonly HistoryOtCommentRangeDescriptor[],
    /** Caller-supplied opaque JSON for future thread/message/author/time presentation. */
    readonly threadData?: JsonValue,
}

export type HistoryOtCommentThreadDirectory =
    | ReadonlyMap<string, JsonValue>
    | Readonly<Record<string, JsonValue | undefined>>;

export interface HistoryOtPresentationOptions {
    readonly members?: HistoryOtMemberDirectory,
    readonly commentThreads?: HistoryOtCommentThreadDirectory,
}

/**
 * A realtime Track Changes model. Its literal kind deliberately cannot be
 * mistaken for the REST History diff attribution model in historyViewProvider.
 */
export interface RealtimeHistoryOtPresentationModel {
    readonly kind: typeof REALTIME_HISTORY_OT_PRESENTATION_KIND,
    readonly snapshotText: string,
    readonly visibleText: string,
    readonly trackedChanges: readonly HistoryOtTrackedChangeDescriptor[],
    readonly comments: readonly HistoryOtCommentAnchorDescriptor[],
}

interface Utf16Line {
    readonly start: number,
    readonly contentEnd: number,
    readonly nextStart: number,
}

interface DirectoryLookup<T> {
    readonly found: boolean,
    readonly value?: T,
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new HistoryOtProtocolError(
            'INVALID_UTF16_POSITION', `${label} must be a non-negative safe integer`,
        );
    }
}

/**
 * UTF-16 line index matching JavaScript/VS Code offset units without changing
 * line endings or Unicode normalization. Offsets inside CRLF clamp to the
 * preceding line end, as VS Code does; reverse mapping selects the CR offset.
 * The supported presentation domain is BMP text with LF/CRLF line endings.
 */
export class Utf16TextIndex {
    private readonly lines: readonly Utf16Line[];

    constructor(readonly text: string) {
        const lines: Utf16Line[] = [];
        let start = 0;
        let offset = 0;
        while (offset < text.length) {
            const codeUnit = text.charCodeAt(offset);
            if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
                throw new HistoryOtProtocolError(
                    'UNSUPPORTED_PRESENTATION_TEXT',
                    'History-OT presentation currently supports BMP text only',
                );
            }
            if (codeUnit === 0x0d) {
                if (text.charCodeAt(offset + 1) !== 0x0a) {
                    throw new HistoryOtProtocolError(
                        'UNSUPPORTED_PRESENTATION_TEXT',
                        'History-OT presentation supports LF and CRLF, not bare CR line endings',
                    );
                }
                const nextStart = offset + 2;
                lines.push({start, contentEnd: offset, nextStart});
                start = nextStart;
                offset = nextStart;
            } else if (codeUnit === 0x0a) {
                lines.push({start, contentEnd: offset, nextStart: offset + 1});
                start = offset + 1;
                offset += 1;
            } else {
                offset += 1;
            }
        }
        lines.push({start, contentEnd: text.length, nextStart: text.length});
        this.lines = lines;
    }

    positionAt(offset: number): Utf16Position {
        assertSafeNonNegativeInteger(offset, 'UTF-16 offset');
        if (offset > this.text.length) {
            throw new HistoryOtProtocolError(
                'INVALID_UTF16_OFFSET',
                `UTF-16 offset must not exceed text length ${this.text.length}`,
            );
        }

        let low = 0;
        let high = this.lines.length - 1;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (this.lines[middle].start <= offset) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        const line = this.lines[low];
        if (offset > line.contentEnd && offset < line.nextStart) {
            return {line: low, character: line.contentEnd - line.start};
        }
        return {line: low, character: offset - line.start};
    }

    offsetAt(position: Utf16Position): number {
        assertSafeNonNegativeInteger(position.line, 'UTF-16 line');
        assertSafeNonNegativeInteger(position.character, 'UTF-16 character');
        if (position.line >= this.lines.length) {
            throw new HistoryOtProtocolError(
                'INVALID_UTF16_POSITION',
                `UTF-16 line must be less than the line count ${this.lines.length}`,
            );
        }
        const line = this.lines[position.line];
        const lineLength = line.contentEnd - line.start;
        if (position.character > lineLength) {
            throw new HistoryOtProtocolError(
                'INVALID_UTF16_POSITION',
                `UTF-16 character must not exceed line length ${lineLength}`,
            );
        }
        return line.start + position.character;
    }
}

export function utf16OffsetToPosition(text: string, offset: number): Utf16Position {
    return new Utf16TextIndex(text).positionAt(offset);
}

export function utf16PositionToOffset(text: string, position: Utf16Position): number {
    return new Utf16TextIndex(text).offsetAt(position);
}

function locateOffset(index: Utf16TextIndex, offset: number): Utf16LocatedOffset {
    return {offset, position: index.positionAt(offset)};
}

function locateRange(index: Utf16TextIndex, startOffset: number, endOffset: number): Utf16LocatedRange {
    return {
        startOffset,
        endOffset,
        start: index.positionAt(startOffset),
        end: index.positionAt(endOffset),
    };
}

function describeSnapshotRange(
    index: Utf16TextIndex,
    range: HistoryOtRange,
): HistoryOtSnapshotRangeDescriptor {
    const endOffset = range.pos + range.length;
    return {
        pos: range.pos,
        length: range.length,
        ...locateRange(index, range.pos, endOffset),
    };
}

function lookupDirectory<T>(
    directory: ReadonlyMap<string, T> | Readonly<Record<string, T | undefined>> | undefined,
    id: string,
): DirectoryLookup<T> {
    if (directory === undefined) {
        return {found: false};
    }
    if (directory instanceof Map) {
        return directory.has(id)
            ? {found: true, value: directory.get(id)}
            : {found: false};
    }
    const record = directory as Readonly<Record<string, T | undefined>>;
    return Object.prototype.hasOwnProperty.call(record, id)
        ? {found: true, value: record[id]}
        : {found: false};
}

function resolveAuthor(
    id: string,
    members: HistoryOtMemberDirectory | undefined,
): HistoryOtAuthorDescriptor {
    const lookup = lookupDirectory(members, id);
    if (!lookup.found) {
        return {id, status: 'unknown'};
    }
    const member = lookup.value;
    if (member === null) {
        return {id, status: 'deleted'};
    }
    if (member === undefined) {
        return {id, status: 'unknown'};
    }
    return {
        id,
        status: member.deleted === true ? 'deleted' : 'known',
        memberId: member.id ?? member._id,
        firstName: member.firstName ?? member.first_name,
        lastName: member.lastName ?? member.last_name,
        email: member.email,
    };
}

function stableComponent(value: string): string {
    return encodeURIComponent(value);
}

function trackedChangeStableId(
    type: 'insert' | 'delete',
    range: HistoryOtRange,
    userId: string,
    timestamp: string,
): string {
    return [
        'history-ot-change',
        type,
        String(range.pos),
        String(range.length),
        stableComponent(userId),
        stableComponent(timestamp),
    ].join(':');
}

function commentStableId(commentId: string): string {
    return `history-ot-comment:${stableComponent(commentId)}`;
}

function commentRangeStableId(commentId: string, index: number, range: HistoryOtRange): string {
    return `${commentStableId(commentId)}:range:${index}:${range.pos}:${range.length}`;
}

function visibleBoundary(
    snapshot: StringFileDataSnapshot,
    snapshotIndex: Utf16TextIndex,
    visibleIndex: Utf16TextIndex,
    visibleOffset: number,
): HistoryOtVisibleBoundaryDescriptor {
    const leftOffset = mapVisibleOffsetToSnapshot(snapshot, visibleOffset, 'left');
    const rightOffset = mapVisibleOffsetToSnapshot(snapshot, visibleOffset, 'right');
    return {
        visible: locateOffset(visibleIndex, visibleOffset),
        snapshotAffinity: {
            left: locateOffset(snapshotIndex, leftOffset),
            right: locateOffset(snapshotIndex, rightOffset),
        },
    };
}

function describeTrackedChanges(
    snapshot: StringFileDataSnapshot,
    snapshotIndex: Utf16TextIndex,
    visibleIndex: Utf16TextIndex,
    members: HistoryOtMemberDirectory | undefined,
): HistoryOtTrackedChangeDescriptor[] {
    return (snapshot.trackedChanges ?? []).map(change => {
        const {range, tracking} = change;
        const endOffset = range.pos + range.length;
        const base = {
            stableId: trackedChangeStableId(
                tracking.type, range, tracking.userId, tracking.ts,
            ),
            authorId: tracking.userId,
            timestamp: tracking.ts,
            author: resolveAuthor(tracking.userId, members),
            snapshotRange: describeSnapshotRange(snapshotIndex, range),
        };
        const text = snapshot.content.slice(range.pos, endOffset);
        if (tracking.type === 'insert') {
            const visibleStart = mapSnapshotOffsetToVisible(snapshot, range.pos);
            const visibleEnd = mapSnapshotOffsetToVisible(snapshot, endOffset);
            return {
                ...base,
                kind: 'tracked-insertion',
                insertedText: text,
                visibleRange: locateRange(visibleIndex, visibleStart, visibleEnd),
            };
        }
        const boundaryOffset = mapSnapshotOffsetToVisible(snapshot, range.pos);
        return {
            ...base,
            kind: 'tracked-deletion',
            deletedText: text,
            visibleBoundary: visibleBoundary(
                snapshot, snapshotIndex, visibleIndex, boundaryOffset,
            ),
        };
    });
}

function cloneThreadData(
    threads: HistoryOtCommentThreadDirectory | undefined,
    commentId: string,
): DirectoryLookup<JsonValue> {
    const lookup = lookupDirectory(threads, commentId);
    if (!lookup.found) {
        return lookup;
    }
    return {found: true, value: deepCloneJson(lookup.value)};
}

function describeComments(
    snapshot: StringFileDataSnapshot,
    snapshotIndex: Utf16TextIndex,
    visibleIndex: Utf16TextIndex,
    threads: HistoryOtCommentThreadDirectory | undefined,
): HistoryOtCommentAnchorDescriptor[] {
    return (snapshot.comments ?? []).map(comment => {
        const rawRanges = comment.ranges.map(range => ({pos: range.pos, length: range.length}));
        const ranges = comment.ranges.map((range, index) => {
            const visibleStart = mapSnapshotOffsetToVisible(snapshot, range.pos);
            const visibleEnd = mapSnapshotOffsetToVisible(
                snapshot, range.pos + range.length,
            );
            const mapped = visibleStart === visibleEnd
                ? {
                    kind: 'boundary' as const,
                    boundary: visibleBoundary(
                        snapshot, snapshotIndex, visibleIndex, visibleStart,
                    ),
                }
                : {
                    kind: 'range' as const,
                    range: locateRange(visibleIndex, visibleStart, visibleEnd),
                };
            return {
                stableId: commentRangeStableId(comment.id, index, range),
                rawRange: {pos: range.pos, length: range.length},
                snapshotRange: describeSnapshotRange(snapshotIndex, range),
                visibleAnchor: mapped,
            };
        });
        const thread = cloneThreadData(threads, comment.id);
        return {
            kind: 'history-ot-comment-anchor',
            stableId: commentStableId(comment.id),
            id: comment.id,
            resolved: comment.resolved === true,
            rawRanges,
            ranges,
            ...(thread.found ? {threadData: thread.value} : {}),
        };
    });
}

export function buildRealtimeHistoryOtPresentation(
    input: HistoryOtSnapshotInput,
    options: HistoryOtPresentationOptions = {},
): RealtimeHistoryOtPresentationModel {
    const snapshot = getSafeSnapshotRaw(input);
    const renderedText = visibleText(snapshot);
    const snapshotIndex = new Utf16TextIndex(snapshot.content);
    const visibleIndex = new Utf16TextIndex(renderedText);
    return {
        kind: REALTIME_HISTORY_OT_PRESENTATION_KIND,
        snapshotText: snapshot.content,
        visibleText: renderedText,
        trackedChanges: describeTrackedChanges(
            snapshot, snapshotIndex, visibleIndex, options.members,
        ),
        comments: describeComments(
            snapshot, snapshotIndex, visibleIndex, options.commentThreads,
        ),
    };
}
