/* eslint-disable @typescript-eslint/naming-convention */
import {strict as assert} from 'assert';
import {
    HistoryOtProtocolError,
    StringFileDataSnapshot,
    parseHistoryOtSnapshot,
} from '../core/historyOt';
import {
    REALTIME_HISTORY_OT_PRESENTATION_KIND,
    buildRealtimeHistoryOtPresentation,
    utf16OffsetToPosition,
    utf16PositionToOffset,
} from '../scm/trackChangesPresentation';

const insertTimestamp = '2026-01-02T03:04:05.000Z';
const deleteTimestamp = '2026-01-02T03:04:06.000Z';

function isProtocolErrorWithCode(code: string): (error: unknown) => boolean {
    return error => error instanceof HistoryOtProtocolError && error.code === code;
}

describe('realtime History OT presentation', () => {
    it('maps Unicode, combining marks, LF, and CRLF in UTF-16 code units', () => {
        const text = 'A\r\n中文 β e\u0301\nZ';

        assert.deepEqual(utf16OffsetToPosition(text, 0), {line: 0, character: 0});
        assert.deepEqual(utf16OffsetToPosition(text, 1), {line: 0, character: 1});
        assert.deepEqual(utf16OffsetToPosition(text, 2), {line: 0, character: 1});
        assert.deepEqual(utf16OffsetToPosition(text, 3), {line: 1, character: 0});
        assert.deepEqual(utf16OffsetToPosition(text, 7), {line: 1, character: 4});
        assert.deepEqual(utf16OffsetToPosition(text, 9), {line: 1, character: 6});
        assert.deepEqual(utf16OffsetToPosition(text, 10), {line: 1, character: 7});
        assert.deepEqual(utf16OffsetToPosition(text, 11), {line: 2, character: 0});
        assert.deepEqual(utf16OffsetToPosition(text, 12), {line: 2, character: 1});

        assert.equal(utf16PositionToOffset(text, {line: 0, character: 1}), 1);
        assert.equal(utf16PositionToOffset(text, {line: 1, character: 4}), 7);
        assert.equal(utf16PositionToOffset(text, {line: 1, character: 6}), 9);
        assert.equal(utf16PositionToOffset(text, {line: 2, character: 1}), 12);

        assert.deepEqual(utf16OffsetToPosition('x\ny', 1), {line: 0, character: 1});
        assert.deepEqual(utf16OffsetToPosition('x\ny', 2), {line: 1, character: 0});
        assert.equal(utf16PositionToOffset('x\ny', {line: 1, character: 0}), 2);

        const emojiText = 'a😀b';
        assert.deepEqual(utf16OffsetToPosition(emojiText, 1), {line: 0, character: 1});
        assert.deepEqual(utf16OffsetToPosition(emojiText, 2), {line: 0, character: 2});
        assert.deepEqual(utf16OffsetToPosition(emojiText, 3), {line: 0, character: 3});
        assert.deepEqual(utf16OffsetToPosition(emojiText, 4), {line: 0, character: 4});
        assert.equal(utf16PositionToOffset(emojiText, {line: 0, character: 1}), 1);
        assert.equal(utf16PositionToOffset(emojiText, {line: 0, character: 2}), 2);
        assert.equal(utf16PositionToOffset(emojiText, {line: 0, character: 3}), 3);

        const emojiModel = buildRealtimeHistoryOtPresentation({
            content: emojiText,
            trackedChanges: [{
                range: {pos: 1, length: 2},
                tracking: {type: 'insert', userId: 'u-emoji', ts: insertTimestamp},
            }],
        });
        const emojiInsertion = emojiModel.trackedChanges[0];
        assert.equal(emojiInsertion.kind, 'tracked-insertion');
        if (emojiInsertion.kind !== 'tracked-insertion') {
            throw new Error('expected emoji insertion');
        }
        assert.equal(emojiInsertion.insertedText, '😀');
        assert.deepEqual(emojiInsertion.visibleRange, {
            startOffset: 1,
            endOffset: 3,
            start: {line: 0, character: 1},
            end: {line: 0, character: 3},
        });
    });

    it('rejects invalid positions and text outside the declared presentation domain', () => {
        assert.throws(
            () => utf16OffsetToPosition('abc', -1),
            isProtocolErrorWithCode('INVALID_UTF16_POSITION'),
        );
        assert.throws(
            () => utf16OffsetToPosition('abc', 4),
            isProtocolErrorWithCode('INVALID_UTF16_OFFSET'),
        );
        assert.throws(
            () => utf16PositionToOffset('abc', {line: 0, character: 4}),
            isProtocolErrorWithCode('INVALID_UTF16_POSITION'),
        );
        assert.throws(
            () => utf16PositionToOffset('abc', {line: 1, character: 0}),
            isProtocolErrorWithCode('INVALID_UTF16_POSITION'),
        );
        assert.throws(
            () => utf16OffsetToPosition('a\rb', 1),
            isProtocolErrorWithCode('UNSUPPORTED_PRESENTATION_TEXT'),
        );
        assert.throws(
            () => utf16OffsetToPosition('a\ud800b', 1),
            isProtocolErrorWithCode('UNSUPPORTED_PRESENTATION_TEXT'),
        );
        assert.throws(
            () => utf16OffsetToPosition('a\udc00b', 1),
            isProtocolErrorWithCode('UNSUPPORTED_PRESENTATION_TEXT'),
        );
    });

    it('describes insertion/deletion text, positions, authors, and unknown users', () => {
        const snapshot: StringFileDataSnapshot = {
            content: 'A\r\n中文 β e\u0301\nNEWold\nz',
            trackedChanges: [
                {
                    range: {pos: 11, length: 3},
                    tracking: {type: 'insert', userId: 'u-insert', ts: insertTimestamp},
                },
                {
                    range: {pos: 14, length: 3},
                    tracking: {type: 'delete', userId: 'u-deleted', ts: deleteTimestamp},
                },
                {
                    range: {pos: 18, length: 1},
                    tracking: {type: 'insert', userId: 'u-unknown', ts: insertTimestamp},
                },
            ],
        };
        const snapshotBefore = JSON.parse(JSON.stringify(snapshot));
        const member = {
            id: 'u-insert',
            first_name: 'Ada',
            last_name: 'Lovelace',
            email: 'ada@example.test',
        };
        const members = new Map([
            ['u-insert', member],
            ['u-deleted', null],
        ]);

        const model = buildRealtimeHistoryOtPresentation(snapshot, {members});

        assert.equal(model.kind, REALTIME_HISTORY_OT_PRESENTATION_KIND);
        assert.notEqual(model.kind, 'rest-history-diff-attribution');
        assert.equal(model.snapshotText, 'A\r\n中文 β e\u0301\nNEWold\nz');
        assert.equal(model.visibleText, 'A\r\n中文 β e\u0301\nNEW\nz');
        assert.equal(model.trackedChanges.length, 3);

        const insertion = model.trackedChanges[0];
        assert.equal(insertion.kind, 'tracked-insertion');
        if (insertion.kind !== 'tracked-insertion') {
            throw new Error('expected insertion');
        }
        assert.equal(insertion.stableId,
            'history-ot-change:insert:11:3:u-insert:2026-01-02T03%3A04%3A05.000Z');
        assert.equal(insertion.authorId, 'u-insert');
        assert.deepEqual(insertion.author, {
            id: 'u-insert',
            status: 'known',
            memberId: 'u-insert',
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@example.test',
        });
        assert.equal(insertion.timestamp, insertTimestamp);
        assert.equal(insertion.insertedText, 'NEW');
        assert.deepEqual(insertion.snapshotRange, {
            pos: 11,
            length: 3,
            startOffset: 11,
            endOffset: 14,
            start: {line: 2, character: 0},
            end: {line: 2, character: 3},
        });
        assert.deepEqual(insertion.visibleRange, {
            startOffset: 11,
            endOffset: 14,
            start: {line: 2, character: 0},
            end: {line: 2, character: 3},
        });

        const deletion = model.trackedChanges[1];
        assert.equal(deletion.kind, 'tracked-deletion');
        if (deletion.kind !== 'tracked-deletion') {
            throw new Error('expected deletion');
        }
        assert.equal(deletion.authorId, 'u-deleted');
        assert.deepEqual(deletion.author, {id: 'u-deleted', status: 'deleted'});
        assert.equal(deletion.deletedText, 'old');
        assert.deepEqual(deletion.snapshotRange, {
            pos: 14,
            length: 3,
            startOffset: 14,
            endOffset: 17,
            start: {line: 2, character: 3},
            end: {line: 2, character: 6},
        });
        assert.deepEqual(deletion.visibleBoundary, {
            visible: {offset: 14, position: {line: 2, character: 3}},
            snapshotAffinity: {
                left: {offset: 14, position: {line: 2, character: 3}},
                right: {offset: 17, position: {line: 2, character: 6}},
            },
        });

        const unknown = model.trackedChanges[2];
        assert.equal(unknown.kind, 'tracked-insertion');
        assert.deepEqual(unknown.author, {id: 'u-unknown', status: 'unknown'});
        if (unknown.kind !== 'tracked-insertion') {
            throw new Error('expected insertion');
        }
        assert.deepEqual(unknown.visibleRange, {
            startOffset: 15,
            endOffset: 16,
            start: {line: 3, character: 0},
            end: {line: 3, character: 1},
        });

        assert.deepEqual(snapshot, snapshotBefore);
        assert.deepEqual(member, {
            id: 'u-insert',
            first_name: 'Ada',
            last_name: 'Lovelace',
            email: 'ada@example.test',
        });
    });

    it('locates multi-line tracked changes without flattening line boundaries', () => {
        const model = buildRealtimeHistoryOtPresentation({
            content: 'a\nI1\nI2\nD1\nD2\nz',
            trackedChanges: [
                {
                    range: {pos: 2, length: 6},
                    tracking: {type: 'insert', userId: 'u1', ts: insertTimestamp},
                },
                {
                    range: {pos: 8, length: 6},
                    tracking: {type: 'delete', userId: 'u2', ts: deleteTimestamp},
                },
            ],
        });

        assert.equal(model.visibleText, 'a\nI1\nI2\nz');
        const insertion = model.trackedChanges[0];
        const deletion = model.trackedChanges[1];
        assert.equal(insertion.kind, 'tracked-insertion');
        assert.equal(deletion.kind, 'tracked-deletion');
        if (insertion.kind !== 'tracked-insertion' || deletion.kind !== 'tracked-deletion') {
            throw new Error('unexpected tracked-change kinds');
        }
        assert.equal(insertion.insertedText, 'I1\nI2\n');
        assert.deepEqual(insertion.visibleRange, {
            startOffset: 2,
            endOffset: 8,
            start: {line: 1, character: 0},
            end: {line: 3, character: 0},
        });
        assert.equal(deletion.deletedText, 'D1\nD2\n');
        assert.deepEqual(deletion.snapshotRange.end, {line: 5, character: 0});
        assert.deepEqual(deletion.visibleBoundary, {
            visible: {offset: 8, position: {line: 3, character: 0}},
            snapshotAffinity: {
                left: {offset: 8, position: {line: 3, character: 0}},
                right: {offset: 14, position: {line: 5, character: 0}},
            },
        });
    });

    it('keeps adjacent deletions distinct and preserves both boundary affinities', () => {
        const model = buildRealtimeHistoryOtPresentation({
            content: 'abXYcd',
            trackedChanges: [
                {
                    range: {pos: 2, length: 1},
                    tracking: {type: 'delete', userId: 'u-x', ts: insertTimestamp},
                },
                {
                    range: {pos: 3, length: 1},
                    tracking: {type: 'delete', userId: 'u-y', ts: deleteTimestamp},
                },
            ],
        });

        assert.equal(model.visibleText, 'abcd');
        assert.notEqual(model.trackedChanges[0].stableId, model.trackedChanges[1].stableId);
        for (const [index, expectedText] of ['X', 'Y'].entries()) {
            const change = model.trackedChanges[index];
            assert.equal(change.kind, 'tracked-deletion');
            if (change.kind !== 'tracked-deletion') {
                throw new Error('expected deletion');
            }
            assert.equal(change.deletedText, expectedText);
            assert.deepEqual(change.visibleBoundary, {
                visible: {offset: 2, position: {line: 0, character: 2}},
                snapshotAffinity: {
                    left: {offset: 2, position: {line: 0, character: 2}},
                    right: {offset: 4, position: {line: 0, character: 4}},
                },
            });
        }
    });

    it('maps every comment range and deep-copies opaque thread data', () => {
        const snapshot: StringFileDataSnapshot = {
            content: 'abXYcd\nq',
            trackedChanges: [
                {
                    range: {pos: 2, length: 1},
                    tracking: {type: 'delete', userId: 'u-x', ts: insertTimestamp},
                },
                {
                    range: {pos: 3, length: 1},
                    tracking: {type: 'delete', userId: 'u-y', ts: deleteTimestamp},
                },
            ],
            comments: [
                {id: 'c-multi', ranges: [{pos: 0, length: 1}, {pos: 4, length: 2}]},
                {id: 'c-hidden', ranges: [{pos: 2, length: 2}], resolved: true},
                {id: 'c-span', ranges: [{pos: 1, length: 4}]},
            ],
        };
        const snapshotBefore = JSON.parse(JSON.stringify(snapshot));
        const opaqueThread = {
            status: 'kept-verbatim',
            messages: [{
                id: 'm1',
                author: {id: 'u-thread', deleted: false},
                timestamp: '2026-01-02T03:04:07.000Z',
                body: 'thread body',
            }],
            future: {token: 7, flags: [true, null]},
        };
        const threads: Record<string, typeof opaqueThread | undefined> = {
            'c-hidden': opaqueThread,
            'c-span': undefined,
        };

        const model = buildRealtimeHistoryOtPresentation(snapshot, {commentThreads: threads});

        assert.equal(model.comments.length, 3);
        const multi = model.comments[0];
        assert.equal(multi.stableId, 'history-ot-comment:c-multi');
        assert.equal(multi.resolved, false);
        assert.deepEqual(multi.rawRanges, [{pos: 0, length: 1}, {pos: 4, length: 2}]);
        assert.equal(multi.ranges.length, 2);
        assert.deepEqual(multi.ranges[0].visibleAnchor, {
            kind: 'range',
            range: {
                startOffset: 0,
                endOffset: 1,
                start: {line: 0, character: 0},
                end: {line: 0, character: 1},
            },
        });
        assert.deepEqual(multi.ranges[1].visibleAnchor, {
            kind: 'range',
            range: {
                startOffset: 2,
                endOffset: 4,
                start: {line: 0, character: 2},
                end: {line: 0, character: 4},
            },
        });

        const hidden = model.comments[1];
        assert.equal(hidden.id, 'c-hidden');
        assert.equal(hidden.resolved, true);
        assert.deepEqual(hidden.rawRanges, [{pos: 2, length: 2}]);
        assert.deepEqual(hidden.ranges[0].visibleAnchor, {
            kind: 'boundary',
            boundary: {
                visible: {offset: 2, position: {line: 0, character: 2}},
                snapshotAffinity: {
                    left: {offset: 2, position: {line: 0, character: 2}},
                    right: {offset: 4, position: {line: 0, character: 4}},
                },
            },
        });
        assert.deepEqual(hidden.threadData, opaqueThread);
        assert.notEqual(hidden.threadData, opaqueThread);
        assert.notEqual(
            (hidden.threadData as typeof opaqueThread).messages,
            opaqueThread.messages,
        );

        const span = model.comments[2];
        assert.equal(Object.prototype.hasOwnProperty.call(span, 'threadData'), false);
        assert.deepEqual(span.ranges[0].visibleAnchor, {
            kind: 'range',
            range: {
                startOffset: 1,
                endOffset: 3,
                start: {line: 0, character: 1},
                end: {line: 0, character: 3},
            },
        });

        (hidden.threadData as typeof opaqueThread).messages[0].body = 'changed output';
        assert.equal(opaqueThread.messages[0].body, 'thread body');
        assert.deepEqual(snapshot, snapshotBefore);
        assert.equal(threads['c-hidden'], opaqueThread);
    });

    it('keeps joinDoc ranges as a distinct lossless compatibility projection', () => {
        const compatibilityRanges = {
            changes: [{id: 'legacy-change', future: {side: 'left'}}],
            comments: [{id: 'legacy-comment', ranges: [{from: 1, to: 2}]}],
            futureTopLevel: {keep: [true, null, 7]},
        };
        const expected = JSON.parse(JSON.stringify(compatibilityRanges));
        const model = buildRealtimeHistoryOtPresentation(
            {content: 'abc'},
            {compatibilityRanges},
        );

        assert.deepEqual(model.compatibilityRanges, expected);
        assert.notEqual(model.compatibilityRanges, compatibilityRanges);
        compatibilityRanges.changes[0].future.side = 'right';
        compatibilityRanges.comments[0].ranges[0].from = 99;
        assert.deepEqual(model.compatibilityRanges, expected);
        assert.equal(model.trackedChanges.length, 0);
        assert.equal(model.comments.length, 0);
    });

    it('builds stable descriptors for opaque ids containing lone surrogates', () => {
        const model = buildRealtimeHistoryOtPresentation(
            parseHistoryOtSnapshot({
                content: 'a',
                comments: [{id: '\uD800', ranges: [{pos: 0, length: 1}]}],
            }),
            {},
        );
        assert.equal(model.comments[0].stableId, 'history-ot-comment:%ud800');
    });

    it('fails closed for malformed or unsafe snapshots', () => {
        const malformed = {
            content: 'abc',
            trackedChanges: [{
                range: {pos: 2, length: 2},
                tracking: {type: 'delete', userId: 'u', ts: deleteTimestamp},
            }],
        };
        const parsed = parseHistoryOtSnapshot(malformed);
        assert.equal(parsed.safe, false);

        assert.throws(
            () => buildRealtimeHistoryOtPresentation(malformed),
            isProtocolErrorWithCode('UNSAFE_SNAPSHOT'),
        );
        assert.throws(
            () => buildRealtimeHistoryOtPresentation(parsed),
            isProtocolErrorWithCode('UNSAFE_SNAPSHOT'),
        );
        assert.deepEqual(malformed, {
            content: 'abc',
            trackedChanges: [{
                range: {pos: 2, length: 2},
                tracking: {type: 'delete', userId: 'u', ts: deleteTimestamp},
            }],
        });
    });
});
