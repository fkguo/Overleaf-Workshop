import {strict as assert} from 'assert';
import {
    HistoryOtProtocolError,
    applyHistoryOtOperations,
    assertHistoryOtOperationsSafe,
    assertHistoryOtWireOperationSafe,
    buildAcceptTrackedChangesOperation,
    buildHistoryOtTextUpdate,
    buildRejectTrackedChangesOperation,
    composeHistoryOtOperations,
    getVisibleHistoryOtText,
    getSafeHistoryOtWireOperation,
    invertHistoryOtOperations,
    parseHistoryOtOperations,
    parseHistoryOtOperationSequence,
    parseHistoryOtSnapshot,
    parseHistoryOtWireOperation,
    serializeHistoryOtOperations,
    serializeHistoryOtSnapshot,
    serializeHistoryOtWireOperation,
    snapshotOffsetToVisible,
    transformHistoryOtOperations,
    visibleOffsetToSnapshot,
} from '../core/historyOt';

const timestamp = '2026-08-31T06:00:00.000Z';

function rawSnapshot(snapshot: ReturnType<typeof parseHistoryOtSnapshot>): unknown {
    return serializeHistoryOtSnapshot(snapshot);
}

function rawOperations(operations: ReturnType<typeof parseHistoryOtOperations>): unknown {
    return serializeHistoryOtOperations(operations);
}

function simpleTextOperation(
    baseLength: number,
    pos: number,
    insertion = '',
    deletionLength = 0,
): ReturnType<typeof parseHistoryOtOperations> {
    const scans: Array<number | string> = [];
    if (pos > 0) {
        scans.push(pos);
    }
    if (insertion.length > 0) {
        scans.push(insertion);
    }
    if (deletionLength > 0) {
        scans.push(-deletionLength);
    }
    const trailing = baseLength - pos - deletionLength;
    if (trailing > 0) {
        scans.push(trailing);
    }
    return parseHistoryOtOperations([{textOperation: scans}]);
}

function simpleTextOperations(baseLength: number): ReturnType<typeof parseHistoryOtOperations>[] {
    const operations = [simpleTextOperation(baseLength, 0)];
    for (let pos = 0; pos <= baseLength; pos += 1) {
        operations.push(simpleTextOperation(baseLength, pos, 'X'));
    }
    for (let pos = 0; pos < baseLength; pos += 1) {
        operations.push(simpleTextOperation(baseLength, pos, '', 1));
    }
    return operations;
}

describe('History-OT lossless protocol parsing', () => {
    it('round-trips the supported snapshot schema by deep copy', () => {
        const input = {
            content: 'A中βe\u0301\r\nZ',
            comments: [{
                id: 'comment-1',
                ranges: [{pos: 1, length: 2}],
                resolved: false,
            }],
            trackedChanges: [{
                range: {pos: 4, length: 1},
                tracking: {type: 'insert', userId: 'user-1', ts: timestamp},
            }],
        };
        const parsed = parseHistoryOtSnapshot(input);

        assert.equal(parsed.safe, true);
        assert.deepEqual(serializeHistoryOtSnapshot(parsed), input);
        input.comments[0].ranges[0].pos = 2;
        assert.equal((serializeHistoryOtSnapshot(parsed) as typeof input).comments[0].ranges[0].pos, 1);
    });

    it('retains unknown snapshot fields exactly but marks the closed schema unsafe', () => {
        const input = {
            content: 'abc',
            futureSnapshotField: {revision: 7},
            comments: [{
                id: 'c',
                ranges: [{pos: 0, length: 1, futureRangeField: 'left'}],
                thread: {messages: []},
            }],
            trackedChanges: [{
                range: {pos: 1, length: 1},
                tracking: {type: 'insert', userId: 'u', ts: timestamp, authorRole: 'owner'},
                source: {kind: 'editor'},
            }],
        };
        const parsed = parseHistoryOtSnapshot(input);
        assert.equal(parsed.safe, false);
        assert.deepEqual(serializeHistoryOtSnapshot(parsed), input);
        assert.throws(
            () => applyHistoryOtOperations(parsed, parseHistoryOtOperations([])),
            /Unsafe History-OT snapshot/,
        );
    });

    it('retains unsafe unknown and malformed operations for exact serialization', () => {
        const cases = [
            [{futureOperation: {kind: 'merge-thread'}, author: {id: 'u'}}],
            [{textOperation: [{i: 'x', semanticFutureKey: true}]}],
            [{textOperation: [{r: 1, commentIds: ['c']}]}],
            [{textOperation: [1.5]}],
            [{textOperation: [{r: 1, tracking: {type: 'delete', userId: 'u', ts: 'bad'}}]}],
            [{textOperation: [2 * 1024 * 1024 + 1]}],
            [{textOperation: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]}],
            [{commentId: 'c', ranges: [{pos: 0, length: 0}]}],
            [{commentId: 'c', ranges: [{pos: Number.MAX_SAFE_INTEGER, length: 1}]}],
            [{commentId: 'c', ranges: [{pos: 0, length: 1}], deleteComment: 'c'}],
            [{commentId: 'c'}],
        ];
        for (const input of cases) {
            const parsed = parseHistoryOtOperations(input);
            assert.equal(parsed.safe, false, JSON.stringify(input));
            assert.deepEqual(serializeHistoryOtOperations(parsed), input);
            assert.throws(() => assertHistoryOtOperationsSafe(parsed), HistoryOtProtocolError);
        }
    });

    it('separates exact-one realtime wire envelopes from offline operation sequences', () => {
        const single = [{textOperation: [1]}];
        const wire = parseHistoryOtWireOperation(single);
        assert.equal(wire.safe, true);
        assert.deepEqual(serializeHistoryOtWireOperation(wire), single);
        assert.deepEqual(getSafeHistoryOtWireOperation(wire), single[0]);

        for (const input of [
            [],
            [{textOperation: [1]}, {noOp: true}],
            [{futureOperation: true}],
        ]) {
            const parsed = parseHistoryOtWireOperation(input);
            assert.equal(parsed.safe, false);
            assert.deepEqual(serializeHistoryOtWireOperation(parsed), input);
            assert.throws(() => assertHistoryOtWireOperationSafe(parsed), HistoryOtProtocolError);
        }
        assert.equal(parseHistoryOtOperationSequence([
            {textOperation: [1]}, {noOp: true},
        ]).safe, true);
    });

    it('labels touching comment ranges as an adapter safety narrowing', () => {
        const input = {
            content: 'ab',
            comments: [{id: 'c', ranges: [{pos: 0, length: 1}, {pos: 1, length: 1}]}],
        };
        const parsed = parseHistoryOtSnapshot(input);
        assert.equal(parsed.safe, false);
        assert.deepEqual(serializeHistoryOtSnapshot(parsed), input);
        assert.match(parsed.unsafeReasons.join('; '), /upstream-canonical pre-merged/);
    });

    it('does not confuse opaque kind/raw snapshot fields with parser wrappers', () => {
        const input = {
            content: 'x',
            kind: 'history-ot-snapshot',
            raw: {content: 'opaque nested value'},
        };
        const parsed = parseHistoryOtSnapshot(input);
        assert.equal(parsed.safe, false);
        assert.deepEqual(serializeHistoryOtSnapshot(input), input);
        assert.deepEqual(serializeHistoryOtSnapshot(parsed), input);
    });

    it('round-trips reserved JSON object keys without prototype mutation', () => {
        const input = JSON.parse(
            '{"content":"x","__proto__":{"future":1},"constructor":{"future":2}}',
        ) as Record<string, unknown>;
        const parsed = parseHistoryOtSnapshot(input);
        const serialized = serializeHistoryOtSnapshot(parsed) as Record<string, unknown>;
        assert.equal(parsed.safe, false);
        assert.deepEqual(serialized, input);
        assert.equal(Object.getPrototypeOf(serialized), Object.prototype);
        assert.equal(Object.prototype.hasOwnProperty.call(serialized, '__proto__'), true);
    });

    it('marks invalid snapshot ranges and tracking unsafe without losing them', () => {
        const input = {
            content: 'abc',
            comments: [{id: 'c', ranges: [{pos: 2, length: 2}]}],
            trackedChanges: [{
                range: {pos: 0, length: 0},
                tracking: {type: 'future', userId: '', ts: 'invalid'},
            }],
        };
        const parsed = parseHistoryOtSnapshot(input);
        assert.equal(parsed.safe, false);
        assert.deepEqual(serializeHistoryOtSnapshot(parsed), input);
        assert.throws(
            () => applyHistoryOtOperations(parsed, parseHistoryOtOperations([])),
            /Unsafe History-OT snapshot/,
        );
    });

    it('rejects non-JSON values because an exact JSON round trip is impossible', () => {
        assert.throws(
            () => parseHistoryOtOperations([{textOperation: [Number.NaN]}]),
            /non-finite number/,
        );
        assert.throws(
            () => parseHistoryOtSnapshot({content: 'x', future: undefined}),
            /cannot round-trip through JSON/,
        );
    });
});

describe('History-OT snapshot application', () => {
    it('applies UTF-16 text scans and updates comment ranges without mutating inputs', () => {
        const snapshotInput = {
            content: 'abcdef',
            comments: [{id: 'c1', ranges: [{pos: 1, length: 4}]}],
        };
        const operationsInput = [{textOperation: [2, 'X', 4]}];
        const snapshotBefore = JSON.parse(JSON.stringify(snapshotInput));
        const operationsBefore = JSON.parse(JSON.stringify(operationsInput));

        const after = applyHistoryOtOperations(
            parseHistoryOtSnapshot(snapshotInput),
            parseHistoryOtOperations(operationsInput),
        );

        assert.deepEqual(snapshotInput, snapshotBefore);
        assert.deepEqual(operationsInput, operationsBefore);
        assert.deepEqual(rawSnapshot(after), {
            content: 'abXcdef',
            comments: [{
                id: 'c1',
                ranges: [{pos: 1, length: 1}, {pos: 3, length: 3}],
            }],
        });
    });

    it('extends only comments named by an inserted scan operation', () => {
        const snapshot = parseHistoryOtSnapshot({
            content: 'abcd',
            comments: [
                {id: 'attached', ranges: [{pos: 1, length: 2}]},
                {id: 'split', ranges: [{pos: 1, length: 2}]},
            ],
        });
        const after = applyHistoryOtOperations(snapshot, parseHistoryOtOperations([{
            textOperation: [2, {i: 'X', commentIds: ['attached']}, 2],
        }]));
        assert.deepEqual((rawSnapshot(after) as any).comments, [
            {id: 'attached', ranges: [{pos: 1, length: 3}]},
            {id: 'split', ranges: [{pos: 1, length: 1}, {pos: 3, length: 1}]},
        ]);
    });

    it('applies an explicitly offline operation sequence, including comment state changes', () => {
        const after = applyHistoryOtOperations(
            parseHistoryOtSnapshot({content: 'abc'}),
            parseHistoryOtOperationSequence([
                {commentId: 'c', ranges: [{pos: 0, length: 2}], resolved: false},
                {commentId: 'c', resolved: true},
                {textOperation: [1, 'X', 2]},
            ]),
        );
        assert.deepEqual(rawSnapshot(after), {
            content: 'aXbc',
            comments: [{id: 'c', ranges: [{pos: 0, length: 1}, {pos: 2, length: 1}], resolved: true}],
        });
    });

    it('canonicalizes optional snapshot fields after apply without changing parse serialization', () => {
        const raw = {
            content: 'abc',
            comments: [{id: 'c', ranges: [{pos: 0, length: 1}], resolved: false}],
            trackedChanges: [],
        };
        const parsed = parseHistoryOtSnapshot(raw);
        assert.deepEqual(serializeHistoryOtSnapshot(parsed), raw);
        assert.deepEqual(
            rawSnapshot(applyHistoryOtOperations(parsed, parseHistoryOtOperations([]))),
            {content: 'abc', comments: [{id: 'c', ranges: [{pos: 0, length: 1}]}]},
        );
        assert.deepEqual(
            rawSnapshot(applyHistoryOtOperations(
                parsed,
                parseHistoryOtOperations([{deleteComment: 'c'}]),
            )),
            {content: 'abc'},
        );
    });

    it('fails closed on incomplete scans, over-removes, and output length overflow', () => {
        const snapshot = parseHistoryOtSnapshot({content: 'abc'});
        assert.throws(
            () => applyHistoryOtOperations(snapshot, parseHistoryOtOperations([{textOperation: [2]}])),
            /base length 2 does not match snapshot length 3/,
        );
        assert.throws(
            () => applyHistoryOtOperations(snapshot, parseHistoryOtOperations([{textOperation: [-4]}])),
            /base length 4 does not match snapshot length 3/,
        );
        const hugeInsert = 'x'.repeat(2 * 1024 * 1024 + 1);
        assert.throws(
            () => applyHistoryOtOperations(
                parseHistoryOtSnapshot({content: ''}),
                parseHistoryOtOperations([{textOperation: [hugeInsert]}]),
            ),
            /target length exceeds|result exceeds/,
        );
    });
});

describe('History-OT tracked edits and visible offsets', () => {
    it('builds and applies tracked insertion and deletion updates', () => {
        const original = parseHistoryOtSnapshot({content: 'abc'});
        const inserted = buildHistoryOtTextUpdate(original, [{
            pos: 1,
            insertText: '中',
            tracking: {userId: 'u1', ts: timestamp},
        }]);
        assert.deepEqual(rawOperations(inserted), [{
            textOperation: [
                1,
                {i: '中', tracking: {type: 'insert', userId: 'u1', ts: timestamp}},
                2,
            ],
        }]);
        const afterInsert = applyHistoryOtOperations(original, inserted);
        assert.deepEqual(rawSnapshot(afterInsert), {
            content: 'a中bc',
            trackedChanges: [{
                range: {pos: 1, length: 1},
                tracking: {type: 'insert', userId: 'u1', ts: timestamp},
            }],
        });

        const deletion = buildHistoryOtTextUpdate(afterInsert, [{
            pos: 2,
            deleteLength: 1,
            tracking: {userId: 'u1', ts: timestamp},
        }]);
        const afterDelete = applyHistoryOtOperations(afterInsert, deletion);
        assert.equal((rawSnapshot(afterDelete) as any).content, 'a中bc');
        assert.equal(getVisibleHistoryOtText(afterDelete), 'a中c');
        assert.deepEqual((rawSnapshot(afterDelete) as any).trackedChanges, [
            {
                range: {pos: 1, length: 1},
                tracking: {type: 'insert', userId: 'u1', ts: timestamp},
            },
            {
                range: {pos: 2, length: 1},
                tracking: {type: 'delete', userId: 'u1', ts: timestamp},
            },
        ]);
    });

    it('requires ISO-8601 instants and canonicalizes generated timestamps to UTC', () => {
        const nonIso = {
            content: 'a',
            trackedChanges: [{
                range: {pos: 0, length: 1},
                tracking: {type: 'insert', userId: 'u', ts: 'August 31, 2026'},
            }],
        };
        const parsed = parseHistoryOtSnapshot(nonIso);
        assert.equal(parsed.safe, false);
        assert.deepEqual(serializeHistoryOtSnapshot(parsed), nonIso);
        assert.equal(parseHistoryOtSnapshot({
            content: 'a',
            trackedChanges: [{
                range: {pos: 0, length: 1},
                tracking: {type: 'insert', userId: 'u', ts: '2026-02-30T00:00:00.000Z'},
            }],
        }).safe, false);
        assert.throws(
            () => buildHistoryOtTextUpdate(
                parseHistoryOtSnapshot({content: 'a'}),
                [{pos: 0, insertText: 'x', tracking: {userId: 'u', ts: 'August 31, 2026'}}],
            ),
            /ISO-8601 timestamp/,
        );

        const offsetTimestamp = '2026-08-31T14:00:00+08:00';
        const generated = buildHistoryOtTextUpdate(
            parseHistoryOtSnapshot({content: 'a'}),
            [{pos: 0, insertText: 'x', tracking: {userId: 'u', ts: offsetTimestamp}}],
        );
        assert.deepEqual(rawOperations(generated), [{
            textOperation: [{
                i: 'x',
                tracking: {type: 'insert', userId: 'u', ts: timestamp},
            }, 1],
        }]);
        const offsetSnapshot = parseHistoryOtSnapshot({
            content: 'a',
            trackedChanges: [{
                range: {pos: 0, length: 1},
                tracking: {type: 'insert', userId: 'u', ts: offsetTimestamp},
            }],
        });
        assert.equal(offsetSnapshot.safe, true);
        assert.equal(
            ((rawSnapshot(applyHistoryOtOperations(
                offsetSnapshot, parseHistoryOtOperations([]),
            )) as any).trackedChanges[0].tracking.ts),
            timestamp,
        );
    });

    it('projects tracked deletions and exposes both collapsed-boundary affinities', () => {
        const snapshot = parseHistoryOtSnapshot({
            content: 'abXXcd',
            trackedChanges: [{
                range: {pos: 2, length: 2},
                tracking: {type: 'delete', userId: 'u', ts: timestamp},
            }],
        });
        assert.equal(getVisibleHistoryOtText(snapshot), 'abcd');
        assert.equal(snapshotOffsetToVisible(snapshot, 2), 2);
        assert.equal(snapshotOffsetToVisible(snapshot, 3), 2);
        assert.equal(snapshotOffsetToVisible(snapshot, 4), 2);
        assert.equal(snapshotOffsetToVisible(snapshot, 6), 4);
        assert.equal(visibleOffsetToSnapshot(snapshot, 2), 2);
        assert.equal(visibleOffsetToSnapshot(snapshot, 3), 5);
        assert.equal(visibleOffsetToSnapshot(snapshot, 2, 'right'), 4);
        assert.equal(visibleOffsetToSnapshot(snapshot, 4, 'right'), 6);
    });

    it('matches the official left boundary at EOF while permitting explicit right affinity', () => {
        const snapshot = parseHistoryOtSnapshot({
            content: 'abXX',
            trackedChanges: [{
                range: {pos: 2, length: 2},
                tracking: {type: 'delete', userId: 'u', ts: timestamp},
            }],
        });
        assert.equal(getVisibleHistoryOtText(snapshot), 'ab');
        assert.equal(visibleOffsetToSnapshot(snapshot, 2), 2);
        assert.equal(visibleOffsetToSnapshot(snapshot, 2, 'right'), 4);
    });

    it('maps across every adjacent tracked deletion at an explicit right boundary', () => {
        const snapshot = parseHistoryOtSnapshot({
            content: 'abXXYYc',
            trackedChanges: [
                {
                    range: {pos: 2, length: 2},
                    tracking: {type: 'delete', userId: 'u1', ts: timestamp},
                },
                {
                    range: {pos: 4, length: 2},
                    tracking: {type: 'delete', userId: 'u2', ts: timestamp},
                },
            ],
        });
        assert.equal(getVisibleHistoryOtText(snapshot), 'abc');
        assert.equal(visibleOffsetToSnapshot(snapshot, 2), 2);
        assert.equal(visibleOffsetToSnapshot(snapshot, 2, 'right'), 6);
        assert.equal(visibleOffsetToSnapshot(snapshot, 3, 'right'), 7);
        for (let snapshotOffset = 2; snapshotOffset <= 6; snapshotOffset += 1) {
            assert.equal(snapshotOffsetToVisible(snapshot, snapshotOffset), 2);
        }
    });

    it('counts CRLF, Chinese, Greek, and combining BMP code units without normalization', () => {
        const content = 'A\r\n中βe\u0301Z';
        assert.equal(content.length, 8);
        const update = buildHistoryOtTextUpdate(
            parseHistoryOtSnapshot({content}),
            [{pos: 3, insertText: 'Ω'}, {pos: 5, deleteLength: 2}],
        );
        const after = applyHistoryOtOperations(parseHistoryOtSnapshot({content}), update);
        assert.equal((rawSnapshot(after) as any).content, 'A\r\nΩ中βZ');
    });

    it('forbids non-BMP insertions but permits them in an existing snapshot', () => {
        const existing = parseHistoryOtSnapshot({content: 'a😀b'});
        assert.equal(existing.safe, true);
        assert.equal((existing.raw as any).content.length, 4);
        assert.equal(parseHistoryOtOperations([{textOperation: ['😀']}]).safe, false);
        assert.throws(
            () => buildHistoryOtTextUpdate(existing, [{pos: 1, insertText: '😀'}]),
            /does not support inserted non-BMP/,
        );
    });

    it('builds accept and reject operations for exact selected tracked ranges', () => {
        const snapshot = parseHistoryOtSnapshot({
            content: 'aIbDc',
            trackedChanges: [
                {
                    range: {pos: 1, length: 1},
                    tracking: {type: 'insert', userId: 'u', ts: timestamp},
                },
                {
                    range: {pos: 3, length: 1},
                    tracking: {type: 'delete', userId: 'u', ts: timestamp},
                },
            ],
        });
        const selected = [{pos: 1, length: 1}, {pos: 3, length: 1}];
        const accepted = applyHistoryOtOperations(
            snapshot, buildAcceptTrackedChangesOperation(snapshot, selected),
        );
        assert.deepEqual(rawSnapshot(accepted), {content: 'aIbc'});

        const rejected = applyHistoryOtOperations(
            snapshot, buildRejectTrackedChangesOperation(snapshot, selected),
        );
        assert.deepEqual(rawSnapshot(rejected), {content: 'abDc'});
        assert.throws(
            () => buildAcceptTrackedChangesOperation(snapshot, [{pos: 0, length: 1}]),
            /does not exactly identify/,
        );
    });

    it('accepts and rejects adjacent tracked insert/delete ranges without offset drift', () => {
        const snapshot = parseHistoryOtSnapshot({
            content: 'ID',
            trackedChanges: [
                {
                    range: {pos: 0, length: 1},
                    tracking: {type: 'insert', userId: 'insert-user', ts: timestamp},
                },
                {
                    range: {pos: 1, length: 1},
                    tracking: {type: 'delete', userId: 'delete-user', ts: timestamp},
                },
            ],
        });
        const both = [{pos: 0, length: 1}, {pos: 1, length: 1}];
        assert.deepEqual(rawSnapshot(applyHistoryOtOperations(
            snapshot, buildAcceptTrackedChangesOperation(snapshot, both),
        )), {content: 'I'});
        assert.deepEqual(rawSnapshot(applyHistoryOtOperations(
            snapshot, buildRejectTrackedChangesOperation(snapshot, both),
        )), {content: 'D'});

        assert.deepEqual(rawSnapshot(applyHistoryOtOperations(
            snapshot,
            buildRejectTrackedChangesOperation(snapshot, [{pos: 0, length: 1}]),
        )), {
            content: 'D',
            trackedChanges: [{
                range: {pos: 0, length: 1},
                tracking: {type: 'delete', userId: 'delete-user', ts: timestamp},
            }],
        });
        assert.deepEqual(rawSnapshot(applyHistoryOtOperations(
            snapshot,
            buildAcceptTrackedChangesOperation(snapshot, [{pos: 1, length: 1}]),
        )), {
            content: 'I',
            trackedChanges: [{
                range: {pos: 0, length: 1},
                tracking: {type: 'insert', userId: 'insert-user', ts: timestamp},
            }],
        });
    });
});

describe('History-OT algebra', () => {
    it('satisfies sequential-apply equivalence for text compose', () => {
        const snapshot = parseHistoryOtSnapshot({content: 'abcd'});
        const first = parseHistoryOtOperations([{textOperation: [1, 'X', 3]}]);
        const second = parseHistoryOtOperations([{textOperation: [3, -1, 1]}]);
        const sequential = applyHistoryOtOperations(
            applyHistoryOtOperations(snapshot, first), second,
        );
        const composed = composeHistoryOtOperations(first, second);
        const direct = applyHistoryOtOperations(snapshot, composed);

        assert.deepEqual(rawSnapshot(direct), rawSnapshot(sequential));
        assert.equal((rawSnapshot(direct) as any).content, 'aXbd');
        assert.equal((rawOperations(composed) as any[]).length, 1);
    });

    it('fails closed for tracked and clear-tracking snapshot-free algebra', () => {
        const early = '2024-01-01T00:00:00.000Z';
        const late = '2025-01-01T00:00:00.000Z';
        const trackedBase = parseHistoryOtSnapshot({
            content: 'a',
            trackedChanges: [{
                range: {pos: 0, length: 1},
                tracking: {type: 'insert', userId: 'u', ts: early},
            }],
        });
        const normalTrackedInsert = buildHistoryOtTextUpdate(trackedBase, [{
            pos: 0,
            insertText: 'X',
            tracking: {userId: 'u', ts: late},
        }]);
        const deleteOriginal = parseHistoryOtOperations([{textOperation: [1, -1]}]);
        const removeBase = parseHistoryOtOperations([{textOperation: [-1]}]);
        assert.throws(
            () => composeHistoryOtOperations(normalTrackedInsert, deleteOriginal),
            /cannot preserve authoritative tracking metadata/,
        );
        assert.throws(
            () => transformHistoryOtOperations(removeBase, normalTrackedInsert),
            /cannot preserve authoritative tracking metadata/,
        );

        const clearTracking = parseHistoryOtOperations([{textOperation: [{
            r: 1, tracking: {type: 'none'},
        }]}]);
        assert.throws(
            () => composeHistoryOtOperations(clearTracking, parseHistoryOtOperations([{textOperation: [1]}])),
            /cannot preserve authoritative tracking metadata/,
        );
        assert.throws(
            () => transformHistoryOtOperations(clearTracking, parseHistoryOtOperations([{textOperation: [1]}])),
            /cannot preserve authoritative tracking metadata/,
        );
    });

    it('only folds adjacent compatible array members', () => {
        const first = parseHistoryOtOperations([
            {commentId: 'a', ranges: [{pos: 0, length: 1}]},
            {commentId: 'b', ranges: [{pos: 1, length: 1}]},
        ]);
        const second = parseHistoryOtOperations([
            {commentId: 'b', resolved: true},
            {deleteComment: 'a'},
        ]);
        assert.deepEqual(rawOperations(composeHistoryOtOperations(first, second)), [
            {commentId: 'a', ranges: [{pos: 0, length: 1}]},
            {commentId: 'b', ranges: [{pos: 1, length: 1}], resolved: true},
            {deleteComment: 'a'},
        ]);
    });

    it('keeps parsed operation bytes exact while canonicalizing generated add-comment output', () => {
        const input = [{commentId: 'c', ranges: [{pos: 0, length: 1}], resolved: false}];
        const parsed = parseHistoryOtOperations(input);
        assert.deepEqual(serializeHistoryOtOperations(parsed), input);
        assert.deepEqual(
            rawOperations(composeHistoryOtOperations(parseHistoryOtOperations([]), parsed)),
            [{commentId: 'c', ranges: [{pos: 0, length: 1}]}],
        );
    });

    it('satisfies transform convergence for insert/delete and same-position insert ties', () => {
        const scenarios = [
            {
                snapshot: {content: 'abcd'},
                left: [{textOperation: [1, 'X', 3]}],
                right: [{textOperation: [2, -1, 1]}],
            },
            {
                snapshot: {content: 'ab'},
                left: [{textOperation: [1, 'L', 1]}],
                right: [{textOperation: [1, 'R', 1]}],
            },
        ];

        for (const scenario of scenarios) {
            const snapshot = parseHistoryOtSnapshot(scenario.snapshot);
            const left = parseHistoryOtOperations(scenario.left);
            const right = parseHistoryOtOperations(scenario.right);
            const [leftPrime, rightPrime] = transformHistoryOtOperations(left, right);
            const leftThenRight = applyHistoryOtOperations(
                applyHistoryOtOperations(snapshot, left), rightPrime,
            );
            const rightThenLeft = applyHistoryOtOperations(
                applyHistoryOtOperations(snapshot, right), leftPrime,
            );
            assert.deepEqual(rawSnapshot(leftThenRight), rawSnapshot(rightThenLeft));
        }
    });

    it('passes an exhaustive small-document text algebra scan', () => {
        const baseContent = 'abcd';
        const base = parseHistoryOtSnapshot({content: baseContent});
        const concurrent = simpleTextOperations(baseContent.length);
        for (const left of concurrent) {
            for (const right of concurrent) {
                const [leftPrime, rightPrime] = transformHistoryOtOperations(left, right);
                const leftBranch = applyHistoryOtOperations(
                    applyHistoryOtOperations(base, left), rightPrime,
                );
                const rightBranch = applyHistoryOtOperations(
                    applyHistoryOtOperations(base, right), leftPrime,
                );
                assert.deepEqual(rawSnapshot(leftBranch), rawSnapshot(rightBranch));
            }

            const afterLeft = applyHistoryOtOperations(base, left);
            const intermediateLength = (rawSnapshot(afterLeft) as {content: string}).content.length;
            for (const right of simpleTextOperations(intermediateLength)) {
                const sequential = applyHistoryOtOperations(afterLeft, right);
                const composed = composeHistoryOtOperations(left, right);
                assert.deepEqual(
                    rawSnapshot(applyHistoryOtOperations(base, composed)),
                    rawSnapshot(sequential),
                );
            }

            const inverse = invertHistoryOtOperations(base, left);
            assert.deepEqual(
                rawSnapshot(applyHistoryOtOperations(afterLeft, inverse)),
                rawSnapshot(base),
            );
        }
    });

    it('passes the supported comment-operation transform matrix', () => {
        const base = parseHistoryOtSnapshot({
            content: 'abc',
            comments: [{id: 'c', ranges: [{pos: 0, length: 1}], resolved: false}],
        });
        const operations = [
            parseHistoryOtOperations([{commentId: 'c', ranges: [{pos: 1, length: 1}]}]),
            parseHistoryOtOperations([{commentId: 'd', ranges: [{pos: 2, length: 1}]}]),
            parseHistoryOtOperations([{deleteComment: 'c'}]),
            parseHistoryOtOperations([{commentId: 'c', resolved: true}]),
            parseHistoryOtOperations([{commentId: 'c', resolved: false}]),
            parseHistoryOtOperations([{noOp: true}]),
        ];
        for (const left of operations) {
            for (const right of operations) {
                const leftRaw = rawOperations(left) as Array<Record<string, unknown>>;
                const rightRaw = rawOperations(right) as Array<Record<string, unknown>>;
                if ('ranges' in leftRaw[0] && 'ranges' in rightRaw[0]) {
                    assert.throws(
                        () => transformHistoryOtOperations(left, right),
                        /cannot guarantee exact CommentList wire order/,
                    );
                    continue;
                }
                const [leftPrime, rightPrime] = transformHistoryOtOperations(left, right);
                const leftBranch = applyHistoryOtOperations(
                    applyHistoryOtOperations(base, left), rightPrime,
                );
                const rightBranch = applyHistoryOtOperations(
                    applyHistoryOtOperations(base, right), leftPrime,
                );
                assert.deepEqual(rawSnapshot(leftBranch), rawSnapshot(rightBranch));
            }
        }
    });

    it('fails closed where comment insertion order prevents exact algebra', () => {
        const base = parseHistoryOtSnapshot({content: 'a'});
        const addC = parseHistoryOtOperations([{
            commentId: 'c', ranges: [{pos: 0, length: 1}],
        }]);
        const addD = parseHistoryOtOperations([{
            commentId: 'd', ranges: [{pos: 0, length: 1}],
        }]);
        assert.throws(
            () => transformHistoryOtOperations(addC, addD),
            /cannot guarantee exact CommentList wire order/,
        );
        const ordered = applyHistoryOtOperations(
            base,
            parseHistoryOtOperationSequence([
                {commentId: 'c', ranges: [{pos: 0, length: 1}]},
                {commentId: 'd', ranges: [{pos: 0, length: 1}]},
            ]),
        );
        const commentC = {id: 'c', ranges: [{pos: 0, length: 1}]};
        const commentD = {id: 'd', ranges: [{pos: 0, length: 1}]};
        assert.deepEqual(rawSnapshot(ordered), {content: 'a', comments: [commentC, commentD]});

        const withComments = parseHistoryOtSnapshot({content: 'a', comments: [commentC, commentD]});
        const deleteC = parseHistoryOtOperations([{deleteComment: 'c'}]);
        assert.throws(
            () => invertHistoryOtOperations(withComments, deleteC),
            /cannot be inverted with exact CommentList wire order/,
        );

        const deleteD = parseHistoryOtOperations([{deleteComment: 'd'}]);
        const inverseD = invertHistoryOtOperations(withComments, deleteD);
        assert.deepEqual(rawSnapshot(applyHistoryOtOperations(
            applyHistoryOtOperations(withComments, deleteD), inverseD,
        )), {content: 'a', comments: [commentC, commentD]});
    });

    it('moves concurrent add-comment ranges through text operations', () => {
        const base = parseHistoryOtSnapshot({content: 'abcdef'});
        const text = parseHistoryOtOperations([{textOperation: [2, 'X', 4]}]);
        const add = parseHistoryOtOperations([{
            commentId: 'c', ranges: [{pos: 1, length: 3}], resolved: true,
        }]);
        const [textPrime, addPrime] = transformHistoryOtOperations(text, add);
        const textThenComment = applyHistoryOtOperations(
            applyHistoryOtOperations(base, text), addPrime,
        );
        const commentThenText = applyHistoryOtOperations(
            applyHistoryOtOperations(base, add), textPrime,
        );
        assert.deepEqual(rawSnapshot(textThenComment), rawSnapshot(commentThenText));
        assert.deepEqual((rawSnapshot(textThenComment) as any).comments, [{
            id: 'c', ranges: [{pos: 1, length: 1}, {pos: 3, length: 2}], resolved: true,
        }]);
    });

    it('recovers content, comments, and tracking with a text inverse', () => {
        const snapshot = parseHistoryOtSnapshot({
            content: 'abcd',
            comments: [{id: 'c', ranges: [{pos: 1, length: 2}]}],
            trackedChanges: [{
                range: {pos: 2, length: 1},
                tracking: {type: 'insert', userId: 'u', ts: timestamp},
            }],
        });
        const operation = parseHistoryOtOperations([{
            textOperation: [1, 'XY', -2, 1],
        }]);
        const inverse = invertHistoryOtOperations(snapshot, operation);
        const recovered = applyHistoryOtOperations(
            applyHistoryOtOperations(snapshot, operation), inverse,
        );
        assert.deepEqual(rawSnapshot(recovered), rawSnapshot(snapshot));
    });

    it('fails inversion before it would generate a forbidden surrogate insertion', () => {
        const snapshot = parseHistoryOtSnapshot({content: 'a😀b'});
        const deletion = parseHistoryOtOperations([{textOperation: [1, -2, 1]}]);
        assert.throws(
            () => invertHistoryOtOperations(snapshot, deletion),
            /would reinsert unsupported surrogate text/,
        );
    });

    it('reverses array order and restores overwritten comment state', () => {
        const snapshot = parseHistoryOtSnapshot({
            content: 'abc',
            comments: [{id: 'c', ranges: [{pos: 0, length: 1}], resolved: false}],
        });
        const operations = parseHistoryOtOperations([
            {commentId: 'c', resolved: true},
            {deleteComment: 'c'},
            {noOp: true},
        ]);
        const inverse = invertHistoryOtOperations(snapshot, operations);
        const recovered = applyHistoryOtOperations(
            applyHistoryOtOperations(snapshot, operations), inverse,
        );
        assert.deepEqual(rawSnapshot(recovered), {
            content: 'abc',
            comments: [{id: 'c', ranges: [{pos: 0, length: 1}]}],
        });
    });

    it('fails before inversion when range metadata is outside the closed protocol schema', () => {
        const snapshot = parseHistoryOtSnapshot({
            content: 'abc',
            comments: [{id: 'c', ranges: [{pos: 0, length: 2, futureAnchor: 'left'}]}],
        });
        assert.equal(snapshot.safe, false);
        const operation = parseHistoryOtOperations([{textOperation: [-1, 2]}]);
        assert.throws(
            () => invertHistoryOtOperations(snapshot, operation),
            /Unsafe History-OT snapshot/,
        );
    });
});
