/* eslint-disable @typescript-eslint/naming-convention */
import {strict as assert} from 'assert';
import {mergeHistoryOtMemberDirectory} from '../core/historyOtAuthors';

describe('History OT author directory', () => {
    it('keeps former authors and lets current membership override stale records', () => {
        const directory = mergeHistoryOtMemberDirectory([
            {
                id: 'former',
                email: 'former@example.test',
                first_name: 'Former',
                future: {keep: true},
            },
            {
                id: 'current',
                email: 'stale@example.test',
                first_name: 'Stale',
            },
        ], [
            {
                _id: 'current',
                email: 'current@example.test',
                first_name: 'Current',
            },
        ]) as ReadonlyMap<string, any>;

        assert.deepEqual(directory.get('former'), {
            id: 'former',
            email: 'former@example.test',
            first_name: 'Former',
            future: {keep: true},
        });
        assert.deepEqual(directory.get('current'), {
            _id: 'current',
            email: 'current@example.test',
            first_name: 'Current',
        });
        assert.equal(directory.has('missing'), false);
    });
});
