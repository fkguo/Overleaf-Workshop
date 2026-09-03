import {strict as assert} from 'assert';
import {
    applyHistoryOtOperations,
    getVisibleHistoryOtText,
    parseHistoryOtSnapshot,
    serializeHistoryOtOperations,
    serializeHistoryOtSnapshot,
} from '../core/historyOt';
import {prepareHistoryOtDocumentUpdate} from '../core/historyOtDocument';

const timestamp = '2026-08-31T00:00:00.000Z';

describe('History OT visible document bridge', () => {
    it('maps a tracked edit through a collapsed deletion boundary and preserves metadata', () => {
        const snapshot = parseHistoryOtSnapshot({
            content: 'abXXcd',
            comments: [{
                id: 'comment-a',
                ranges: [{pos: 4, length: 2}],
            }],
            trackedChanges: [{
                range: {pos: 2, length: 2},
                tracking: {type: 'delete', userId: 'u-old', ts: timestamp},
            }],
        });
        const prepared = prepareHistoryOtDocumentUpdate(
            snapshot,
            'abcd',
            'abYcd',
            [{p: 2, i: 'Y'}],
            {userId: 'u-new', ts: timestamp},
        );

        assert.equal(prepared.mergeApplied, true);
        assert.deepEqual(prepared.snapshotEdits, [{
            pos: 2,
            deleteLength: 0,
            insertText: 'Y',
            tracking: {userId: 'u-new', ts: timestamp},
        }]);
        const raw = serializeHistoryOtOperations(prepared.operation!);
        const applied = applyHistoryOtOperations(snapshot, prepared.operation!);
        assert.equal(getVisibleHistoryOtText(applied), 'abYcd');
        assert.match(JSON.stringify(raw), /u-new/);
        assert.equal((applied.raw as any).comments[0].id, 'comment-a');
        assert.deepEqual((applied.raw as any).comments[0].ranges, [{pos: 5, length: 2}]);
    });

    it('fails closed when the authoritative visible base advanced before capture', () => {
        const snapshot = parseHistoryOtSnapshot({content: 'aRbc'});
        const prepared = prepareHistoryOtDocumentUpdate(snapshot, 'abc', 'abcL', [{p: 3, i: 'L'}]);

        assert.equal(prepared.mergeApplied, false);
        assert.equal(prepared.mergedVisibleContent, 'aRbc');
        assert.deepEqual(prepared.snapshotEdits, []);
    });

    it('replaces visible text without consuming a collapsed tracked deletion', () => {
        const snapshot = parseHistoryOtSnapshot({
            content: 'abXXcd',
            trackedChanges: [{
                range: {pos: 2, length: 2},
                tracking: {type: 'delete', userId: 'u-old', ts: timestamp},
            }],
        });
        const prepared = prepareHistoryOtDocumentUpdate(
            snapshot,
            'abcd',
            'abYd',
            [{p: 2, d: 'c'}, {p: 2, i: 'Y'}],
            {userId: 'u-new', ts: timestamp},
        );

        assert.equal(prepared.mergeApplied, true);
        assert.deepEqual(prepared.snapshotEdits, [
            {pos: 4, deleteLength: 1, insertText: '', tracking: {userId: 'u-new', ts: timestamp}},
            {pos: 2, deleteLength: 0, insertText: 'Y', tracking: {userId: 'u-new', ts: timestamp}},
        ]);
        const applied = applyHistoryOtOperations(snapshot, prepared.operation!);
        assert.equal(getVisibleHistoryOtText(applied), 'abYd');
        assert.match(JSON.stringify(applied.raw), /u-old/);
        assert.match(JSON.stringify(applied.raw), /u-new/);
    });

    it('fails closed on overlapping concurrent replacements', () => {
        const prepared = prepareHistoryOtDocumentUpdate(
            parseHistoryOtSnapshot({content: 'aXc'}),
            'aXc',
            'aYc',
            [{p: 1, d: 'X'}, {p: 1, i: 'Y'}],
        );
        assert.equal(prepared.mergeApplied, true);
        assert.equal(prepared.mergedVisibleContent, 'aYc');
    });

    it('returns no operation when the desired visible text is already authoritative', () => {
        const prepared = prepareHistoryOtDocumentUpdate(
            parseHistoryOtSnapshot({content: 'abc'}),
            'abc',
            'abc',
            [],
        );
        assert.equal(prepared.mergeApplied, true);
        assert.equal(prepared.operation, undefined);
    });

    it('rejects unsupported non-BMP insertion without altering the snapshot', () => {
        const snapshot = parseHistoryOtSnapshot({content: 'abc'});
        assert.throws(
            () => prepareHistoryOtDocumentUpdate(snapshot, 'abc', 'a😀bc', [{p: 1, i: '😀'}]),
            /does not support inserted non-BMP characters/,
        );
        assert.equal(getVisibleHistoryOtText(snapshot), 'abc');
    });

    it('rejects an emoji replacement whose diff would split a surrogate pair', () => {
        const snapshot = parseHistoryOtSnapshot({
            content: '😀',
            comments: [{id: 'comment-a', ranges: [{pos: 0, length: 2}]}],
        });
        assert.throws(
            () => prepareHistoryOtDocumentUpdate(
                snapshot,
                '😀',
                '😁',
                [{p: 0, d: '😀'}, {p: 0, i: '😁'}],
            ),
            /cannot edit inside an existing non-BMP character|does not support inserted non-BMP characters/,
        );
        assert.equal(getVisibleHistoryOtText(snapshot), '😀');
        assert.deepEqual((snapshot.raw as any).comments[0].ranges, [{pos: 0, length: 2}]);
    });

    it('preserves sequential tracked ordering in one logical History operation', () => {
        const snapshot = parseHistoryOtSnapshot({content: 'ab'});
        const prepared = prepareHistoryOtDocumentUpdate(
            snapshot,
            'ab',
            'Yb',
            [{p: 1, i: 'Y'}, {p: 0, d: 'a'}],
            {userId: 'u-new', ts: timestamp},
        );

        const rawOperation = serializeHistoryOtOperations(prepared.operation!) as any[];
        assert.equal(rawOperation.length, 1);
        const applied = applyHistoryOtOperations(snapshot, prepared.operation!);
        assert.deepEqual(serializeHistoryOtSnapshot(applied), {
            content: 'aYb',
            trackedChanges: [
                {
                    range: {pos: 0, length: 1},
                    tracking: {type: 'delete', userId: 'u-new', ts: timestamp},
                },
                {
                    range: {pos: 1, length: 1},
                    tracking: {type: 'insert', userId: 'u-new', ts: timestamp},
                },
            ],
        });
        assert.equal(getVisibleHistoryOtText(applied), 'Yb');
    });

    it('rejects a visible surrogate pair separated by a hidden tracked deletion', () => {
        const snapshot = parseHistoryOtSnapshot({
            content: '\uD83Dhidden\uDE00',
            trackedChanges: [{
                range: {pos: 1, length: 6},
                tracking: {type: 'delete', userId: 'u-old', ts: timestamp},
            }],
        });
        assert.equal(getVisibleHistoryOtText(snapshot), '😀');

        assert.throws(
            () => prepareHistoryOtDocumentUpdate(
                snapshot,
                '😀',
                '',
                [{p: 0, d: '😀'}],
            ),
            /visible surrogate pairs must be contiguous/,
        );
        assert.equal((serializeHistoryOtSnapshot(snapshot) as any).content, '\uD83Dhidden\uDE00');
    });
});
