import {strict as assert} from 'assert';
import {resolveHistoryOtDecisionTargets} from '../core/historyOtDecision';

const change = {
    kind: 'tracked-insertion',
    stableId: 'change-a',
    authorId: 'user-a',
    timestamp: '2026-08-31T00:00:00.000Z',
    author: {id: 'user-a', status: 'known'},
    snapshotRange: {
        pos: 2, length: 3, startOffset: 2, endOffset: 5,
        start: {line: 0, character: 2}, end: {line: 0, character: 5},
    },
    insertedText: 'new',
    visibleRange: {
        startOffset: 2, endOffset: 5,
        start: {line: 0, character: 2}, end: {line: 0, character: 5},
    },
} as const;

const model = {
    kind: 'realtime-history-ot-track-changes-presentation-v1',
    snapshotText: 'abnewc',
    visibleText: 'abnewc',
    trackedChanges: [change],
    comments: [],
} as any;

const target = {
    stableId: 'change-a',
    type: 'insert',
    range: {pos: 2, length: 3},
    authorId: 'user-a',
    timestamp: '2026-08-31T00:00:00.000Z',
} as const;

describe('authoritative tracked-change decision targets', () => {
    it('returns only exact full-identity matches', () => {
        assert.deepEqual(
            resolveHistoryOtDecisionTargets(model, [target], 'abnewc'),
            [{pos: 2, length: 3}],
        );
    });

    it('rejects stale text and coordinate-reused or duplicated identities', () => {
        assert.throws(
            () => resolveHistoryOtDecisionTargets(model, [target], 'stale'),
            /text changed/,
        );
        assert.throws(
            () => resolveHistoryOtDecisionTargets(model, [{...target, authorId: 'user-b'}], 'abnewc'),
            /no longer authoritative/,
        );
        assert.throws(
            () => resolveHistoryOtDecisionTargets(model, [target, target], 'abnewc'),
            /Duplicate tracked-change target/,
        );
    });
});
