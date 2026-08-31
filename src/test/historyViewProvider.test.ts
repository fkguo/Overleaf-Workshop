/* eslint-disable @typescript-eslint/naming-convention */
import { strict as assert } from 'assert';
import type {
    ProjectHistoryResponseSchema,
    ProjectUpdateMeta,
    ProjectUpdateResponseSchema,
} from '../api/base';

type HistoryModule = typeof import('../scm/historyViewProvider');

interface ModuleLoader {
    _load(request: string, parent: NodeModule | null, isMain: boolean): unknown,
}

class DisposableStub {
    constructor(private readonly callback?: () => void) {}
    dispose(): void { this.callback?.(); }
    static from(...items: DisposableStub[]): DisposableStub {
        return new DisposableStub(() => items.forEach(item => item.dispose()));
    }
}

class EventEmitterStub {
    readonly event = () => new DisposableStub();
    fire(): void {}
    dispose(): void {}
}

const vscodeStub = {
    Disposable: DisposableStub,
    EventEmitter: EventEmitterStub,
    TreeItem: class {},
    ThemeIcon: class {},
    TreeItemCollapsibleState: {None: 0},
    StatusBarAlignment: {Left: 1, Right: 2},
    FileType: {File: 1, Directory: 2},
    FilePermission: {Readonly: 1},
    UIKind: {Desktop: 1},
    env: {uiKind: 1},
    l10n: {t: (message: string) => message},
    workspace: {
        getConfiguration: () => ({get: (_key: string, fallback: unknown) => fallback}),
    },
    Uri: {
        from: (parts: {scheme: string, path: string, query: string}) => ({
            ...parts,
            toString: () => `${parts.scheme}:${parts.path}?${parts.query}`,
        }),
    },
};

const moduleLoader = require('module') as ModuleLoader;
const originalLoad = moduleLoader._load;
const originalCacheKeys = new Set(Object.keys(require.cache));
let historyModule: HistoryModule;
moduleLoader._load = function(request, parent, isMain): unknown {
    if (request === 'vscode') { return vscodeStub; }
    return originalLoad.call(this, request, parent, isMain);
};
try {
    historyModule = require('../scm/historyViewProvider') as HistoryModule;
} finally {
    moduleLoader._load = originalLoad;
    for (const cacheKey of Object.keys(require.cache)) {
        if (!originalCacheKeys.has(cacheKey)) {
            delete require.cache[cacheKey];
        }
    }
}

const knownUser = {
    id: 'user-1',
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@example.test',
};

function historyRecord(): import('../scm/historyViewProvider').HistoryRecord {
    return {keyVersions: [], revisions: {}, labels: {}, diff: {}};
}

function update(
    fromV: number,
    toV: number,
    overrides: Partial<ProjectHistoryResponseSchema> = {},
): ProjectHistoryResponseSchema {
    return {
        fromV,
        toV,
        meta: {
            users: [knownUser],
            start_ts: 1000,
            end_ts: 2000,
        },
        labels: [],
        pathnames: [],
        project_ops: [],
        ...overrides,
    };
}

describe('history view model', () => {
    it('accepts empty update pages without inventing a current version', () => {
        const record = historyRecord();
        historyModule.mergeHistoryPage(record, {updates: [], nextBeforeTimestamp: 0});

        assert.equal(record.currentVersion, undefined);
        assert.equal(record.before, 0);
        assert.deepEqual(record.keyVersions, []);
    });

    it('keeps the newest current version while appending older pages', () => {
        const record = historyRecord();
        const newest: ProjectUpdateResponseSchema = {
            updates: [update(8, 10)],
            nextBeforeTimestamp: 100,
        };
        const older: ProjectUpdateResponseSchema = {
            updates: [update(3, 5)],
        };

        historyModule.mergeHistoryPage(record, newest);
        historyModule.mergeHistoryPage(record, older);

        assert.equal(record.currentVersion, 10);
        assert.deepEqual(record.keyVersions, [10, 5]);
    });

    it('preserves fromV zero and resolves structural operation versions safely', () => {
        const record = historyRecord();
        historyModule.mergeHistoryPage(record, {
            updates: [update(0, 10, {
                pathnames: ['main.tex'],
                project_ops: [{
                    rename: {pathname: 'old #?.tex', newPathname: 'new % name.tex'},
                    atV: 9,
                }],
            })],
        });

        assert.equal(record.revisions[10].fromV, 0);
        assert.deepEqual(record.diff['old #?.tex'], [9]);
        assert.deepEqual(record.diff['new % name.tex'], [9]);
        assert.equal(historyModule.resolveRevisionVersion(record, 9), 10);
        assert.deepEqual(historyModule.resolveUniqueRevisionVersions(record, [10, 9, 10]), [10]);
        assert.equal(historyModule.describeProjectOperation(record.revisions[10].structuralChanges[0]),
            'Renamed old #?.tex → new % name.tex');
    });

    it('shows all known and unknown participants without calling them a sole author', () => {
        const participants = historyModule.formatHistoryParticipants([knownUser, null, {
            id: 'user-2', first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.test',
        }]);
        assert.deepEqual(participants, [
            'Ada Lovelace (ada@example.test)',
            'Grace Hopper (grace@example.test)',
            'Unknown or deleted participant',
        ]);

        const tooltip = historyModule.buildHistoryTooltipMarkdown({
            fromV: 0,
            timestamp: 2000,
            users: [knownUser, null],
            origin: 'git-bridge',
            structuralChanges: [{add: {pathname: 'chapter.tex'}, atV: 1}],
        }, []);
        assert.match(tooltip, /Participants in this summarized update/);
        assert.match(tooltip, /Ada Lovelace/);
        assert.match(tooltip, /Unknown or deleted participant/);
        assert.match(tooltip, /Git bridge/);
        assert.match(tooltip, /Added chapter/);
        assert.doesNotMatch(tooltip, /\bauthor\b/i);
    });

    it('describes restore origins as well as ordinary origin strings', () => {
        assert.equal(historyModule.describeHistoryOrigin('dropbox'), 'Dropbox sync');
        assert.equal(historyModule.describeHistoryOrigin({
            kind: 'file-restore', path: 'main.tex', version: 7,
        }), 'File restore main.tex from v7');
    });

    it('reconstructs both document sides and retains block attribution metadata', () => {
        const meta: ProjectUpdateMeta = {
            users: [knownUser, null],
            start_ts: 1000,
            end_ts: 2000,
            origin: 'upload',
        };
        const response = {
            diff: [
                {u: 'A'},
                {d: 'old', meta},
                {i: 'new', meta},
                {u: 'Z'},
            ],
        };

        const before = historyModule.buildHistoricalDocument(response, 'before');
        const after = historyModule.buildHistoricalDocument(response, 'after');

        assert.equal(before.text, 'AoldZ');
        assert.deepEqual(before.attributions.map(({start, end, kind}) => ({start, end, kind})), [
            {start: 1, end: 4, kind: 'removed'},
        ]);
        assert.equal(after.text, 'AnewZ');
        assert.deepEqual(after.attributions.map(({start, end, kind}) => ({start, end, kind})), [
            {start: 1, end: 4, kind: 'added'},
        ]);
        assert.deepEqual(after.attributions[0].meta.users, [knownUser, null]);
        const hover = historyModule.buildHistoryAttributionTooltipMarkdown(after.attributions[0]);
        assert.match(hover, /Participants for this changed block/);
        assert.match(hover, /Ada Lovelace/);
        assert.match(hover, /Unknown or deleted participant/);
        assert.match(hover, /File upload/);
        assert.doesNotMatch(hover, /\bauthor\b/i);

        assert.throws(
            () => historyModule.buildHistoricalDocument(
                {diff: {binary: true}},
                'after',
            ),
            /binary or unavailable/,
        );
        assert.throws(() => historyModule.buildHistoricalDocument(undefined, 'after'), /Unable to load/);
        assert.deepEqual(historyModule.buildHistoricalDocument({diff: []}, 'after'), {
            text: '', attributions: [],
        });
    });

    it('keeps reserved pathname characters out of URI query parsing', () => {
        const pathname = 'folder/a #?% b.tex';
        const uri = historyModule.createHistoricalDocumentUri(pathname, {
            version: 3, from: 1, to: 3, side: 'after',
        });

        assert.equal(uri.path, pathname);
        assert.equal(uri.scheme, 'overleaf-workshop-diff');
        assert.deepEqual(historyModule.parseHistoricalDocumentQuery(uri.query), {
            version: 3, from: 1, to: 3, side: 'after',
        });
        assert.equal(historyModule.parseHistoricalDocumentQuery('0')?.version, 0);
        assert.equal(historyModule.parseHistoricalDocumentQuery('version=3&from=1&to=3'), undefined);
        assert.equal(historyModule.parseHistoricalDocumentQuery('version=1&from=1&to=3&side=after'), undefined);
    });
});
