import {strict as assert} from 'assert';
import {readFileSync} from 'fs';
import path = require('path');

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
interface JsonObject {
    [key: string]: JsonValue,
}

interface Provenance extends JsonObject {
    repository: string,
    commit: string,
    path: string,
    lineStart: number,
    lineEnd: number,
    url: string,
}

const officialCommit = '28ad3b03b71cb4311decdcb55c36b33ec10d72db';
const workshopCommit = '046638b5b5762129dc51214ee19fdbef75d3c183';
const fixtureDirectory = path.resolve(process.cwd(), 'src/test/fixtures/history-ot');

function loadFixture(name: string): JsonObject {
    const value = JSON.parse(readFileSync(path.join(fixtureDirectory, name), 'utf8')) as unknown;
    return asObject(value, name);
}

function asObject(value: unknown, pathName: string): JsonObject {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value),
        `${pathName} must be an object`);
    return value as JsonObject;
}

function asArray(value: JsonValue | undefined, pathName: string): JsonValue[] {
    assert.ok(Array.isArray(value), `${pathName} must be an array`);
    return value;
}

function asString(value: JsonValue | undefined, pathName: string): string {
    assert.equal(typeof value, 'string', `${pathName} must be a string`);
    return value as string;
}

function asNumber(value: JsonValue | undefined, pathName: string): number {
    assert.equal(typeof value, 'number', `${pathName} must be a number`);
    return value as number;
}

function collectObjects(value: JsonValue, result: JsonObject[] = []): JsonObject[] {
    if (Array.isArray(value)) {
        value.forEach(child => collectObjects(child, result));
    } else if (value !== null && typeof value === 'object') {
        result.push(value);
        Object.values(value).forEach(child => collectObjects(child, result));
    }
    return result;
}

function validateProvenance(value: JsonValue, location: string): void {
    const source = asObject(value, location) as Provenance;
    assert.ok(source.repository === 'https://github.com/overleaf/overleaf'
        || source.repository === 'https://github.com/fkguo/Overleaf-Workshop');
    const expectedCommit = source.repository.endsWith('/overleaf') ? officialCommit : workshopCommit;
    assert.equal(source.commit, expectedCommit);
    assert.ok(source.path.length > 0 && !source.path.startsWith('/') && !source.path.includes('..'));
    assert.ok(Number.isSafeInteger(source.lineStart) && source.lineStart > 0);
    assert.ok(Number.isSafeInteger(source.lineEnd) && source.lineEnd >= source.lineStart);
    assert.match(source.url, new RegExp(`${expectedCommit}/.+#L${source.lineStart}-L${source.lineEnd}$`));
}

function validateFixtureEnvelope(name: string, fixture: JsonObject): void {
    assert.equal(fixture.fixtureFormat, 'history-ot-fixture-v1', `${name} fixture format`);
    const objects = collectObjects(fixture);
    let provenanceCount = 0;
    for (const [index, object] of objects.entries()) {
        if (object.provenance === undefined) {
            continue;
        }
        const sources = asArray(object.provenance, `${name}.objects[${index}].provenance`);
        assert.ok(sources.length > 0, `${name} provenance must not be empty`);
        sources.forEach((source, sourceIndex) =>
            validateProvenance(source, `${name}.objects[${index}].provenance[${sourceIndex}]`));
        provenanceCount += sources.length;
    }
    assert.ok(provenanceCount > 0, `${name} must carry pinned provenance`);
}

function scanTextOperation(content: string, rawOperations: JsonValue): string {
    let current = content;
    for (const [operationIndex, rawOperation] of asArray(rawOperations, 'rawOperations').entries()) {
        const operation = asObject(rawOperation, `rawOperations[${operationIndex}]`);
        if (operation.textOperation === undefined) {
            continue;
        }
        let cursor = 0;
        let result = '';
        for (const [scanIndex, rawScan] of asArray(
            operation.textOperation, `rawOperations[${operationIndex}].textOperation`,
        ).entries()) {
            if (typeof rawScan === 'number') {
                assert.notEqual(rawScan, 0, `scan ${scanIndex} cannot be zero`);
                if (rawScan > 0) {
                    result += current.slice(cursor, cursor + rawScan);
                    cursor += rawScan;
                } else {
                    cursor -= rawScan;
                }
                continue;
            }
            if (typeof rawScan === 'string') {
                result += rawScan;
                continue;
            }
            const scan = asObject(rawScan, `textOperation[${scanIndex}]`);
            if (typeof scan.i === 'string') {
                result += scan.i;
            } else {
                const retain = asNumber(scan.r, `textOperation[${scanIndex}].r`);
                result += current.slice(cursor, cursor + retain);
                cursor += retain;
            }
        }
        assert.equal(cursor, current.length, `operation ${operationIndex} must consume its base text`);
        current = result;
    }
    return current;
}

function visibleText(rawSnapshot: JsonValue): string {
    const snapshot = asObject(rawSnapshot, 'snapshot');
    const content = asString(snapshot.content, 'snapshot.content');
    if (snapshot.trackedChanges === undefined) {
        return content;
    }
    const deletes = asArray(snapshot.trackedChanges, 'snapshot.trackedChanges')
        .map((rawChange, index) => {
            const change = asObject(rawChange, `trackedChanges[${index}]`);
            const tracking = asObject(change.tracking, `trackedChanges[${index}].tracking`);
            const range = asObject(change.range, `trackedChanges[${index}].range`);
            return {
                type: asString(tracking.type, `trackedChanges[${index}].tracking.type`),
                pos: asNumber(range.pos, `trackedChanges[${index}].range.pos`),
                length: asNumber(range.length, `trackedChanges[${index}].range.length`),
            };
        })
        .filter(change => change.type === 'delete')
        .sort((left, right) => left.pos - right.pos);
    let cursor = 0;
    let result = '';
    for (const deletion of deletes) {
        assert.ok(deletion.pos >= cursor && deletion.pos + deletion.length <= content.length);
        result += content.slice(cursor, deletion.pos);
        cursor = deletion.pos + deletion.length;
    }
    return result + content.slice(cursor);
}

describe('History OT fixture corpus', () => {
    const manifest = loadFixture('manifest.json');
    const fixtureNames = asArray(manifest.files, 'manifest.files')
        .map((name, index) => asString(name, `manifest.files[${index}]`));
    const fixtures = new Map(fixtureNames.map(name => [name, loadFixture(name)]));

    it('pins the verified official source and the requested Workshop baseline', () => {
        const upstream = asObject(manifest.upstream, 'manifest.upstream');
        const baseline = asObject(manifest.workshopBaseline, 'manifest.workshopBaseline');
        assert.equal(upstream.commit, officialCommit);
        assert.equal(upstream.verifiedHead, officialCommit);
        assert.equal(baseline.commit, workshopCommit);
        assert.deepEqual(fixtureNames, [
            'snapshots.json',
            'operations.json',
            'events.json',
            'unsafe.json',
            'rest-diff.json',
        ]);
    });

    it('gives every fixture family pinned path-and-line provenance', () => {
        for (const [name, fixture] of fixtures) {
            validateFixtureEnvelope(name, fixture);
        }
    });

    it('uses unique case ids and covers every declared protocol boundary', () => {
        const ids = new Set<string>();
        const coverage = new Set<string>();
        for (const fixture of fixtures.values()) {
            for (const object of collectObjects(fixture)) {
                if (typeof object.id === 'string' && Array.isArray(object.coverage)) {
                    assert.ok(!ids.has(object.id), `duplicate fixture id ${object.id}`);
                    ids.add(object.id);
                }
                if (Array.isArray(object.coverage)) {
                    object.coverage.forEach(item => coverage.add(asString(item, 'coverage item')));
                }
            }
        }
        const required = asArray(manifest.requiredCoverage, 'manifest.requiredCoverage')
            .map((item, index) => asString(item, `manifest.requiredCoverage[${index}]`));
        assert.deepEqual(required.filter(item => !coverage.has(item)), []);
    });

    it('keeps snapshot text, tracked-delete visibility, and mapping examples self-consistent', () => {
        const snapshots = fixtures.get('snapshots.json')!;
        for (const [index, rawCase] of asArray(snapshots.cases, 'snapshots.cases').entries()) {
            const fixtureCase = asObject(rawCase, `snapshots.cases[${index}]`);
            assert.equal(visibleText(fixtureCase.raw), fixtureCase.expectedVisibleText);
        }
        const adjacent = asObject(asArray(snapshots.cases, 'snapshots.cases')[1], 'adjacent snapshot');
        assert.deepEqual(adjacent.snapshotToVisible, [
            {input: 0, expected: 0},
            {input: 4, expected: 4},
            {input: 7, expected: 7},
            {input: 8, expected: 7},
            {input: 9, expected: 7},
            {input: 10, expected: 7},
            {input: 14, expected: 11},
        ]);
        assert.deepEqual(adjacent.visibleToSnapshot, [
            {input: 0, expected: 0},
            {input: 4, expected: 4},
            {input: 7, expected: 7},
            {input: 8, expected: 11},
            {input: 11, expected: 14},
        ]);
    });

    it('validates source-derived text-operation outcomes with a narrow independent executor', () => {
        const operations = fixtures.get('operations.json')!;
        for (const [index, rawCase] of asArray(operations.applyCases, 'operations.applyCases').entries()) {
            const fixtureCase = asObject(rawCase, `operations.applyCases[${index}]`);
            const base = asObject(fixtureCase.baseSnapshot, `applyCases[${index}].baseSnapshot`);
            const expected = asObject(fixtureCase.expectedSnapshot, `applyCases[${index}].expectedSnapshot`);
            assert.equal(
                scanTextOperation(asString(base.content, 'base content'), fixtureCase.rawOperations),
                expected.content,
            );
            assert.equal(visibleText(expected), fixtureCase.expectedVisibleText);
        }

        const decisions = asObject(operations.trackedChangeDecisions, 'trackedChangeDecisions');
        const decisionBase = asObject(decisions.baseSnapshot, 'trackedChangeDecisions.baseSnapshot');
        assert.equal(
            scanTextOperation(asString(decisionBase.content, 'decision base'), decisions.expectedAcceptOperations),
            asObject(decisions.expectedAcceptedSnapshot, 'accepted snapshot').content,
        );
        assert.equal(
            scanTextOperation(asString(decisionBase.content, 'decision base'), decisions.expectedRejectOperations),
            asObject(decisions.expectedRejectedSnapshot, 'rejected snapshot').content,
        );
    });

    it('records comment add, resolve, and delete as distinct operations', () => {
        const operations = fixtures.get('operations.json')!;
        const lifecycle = asObject(operations.commentLifecycle, 'commentLifecycle');
        const steps = asArray(lifecycle.steps, 'commentLifecycle.steps').map((step, index) =>
            asObject(step, `commentLifecycle.steps[${index}]`));
        assert.deepEqual(steps.map(step => step.name), ['add', 'resolve', 'delete']);
        assert.deepEqual(steps[0].rawOperations, [
            {commentId: 'comment-alpha', ranges: [{pos: 6, length: 4}]},
        ]);
        assert.deepEqual(steps[1].rawOperations, [{commentId: 'comment-alpha', resolved: true}]);
        assert.deepEqual(steps[2].rawOperations, [{deleteComment: 'comment-alpha'}]);
    });

    it('keeps sender acknowledgements and duplicate recovery metadata out of operation payloads', () => {
        const events = fixtures.get('events.json')!;
        const cases = asArray(events.cases, 'events.cases').map((event, index) =>
            asObject(event, `events.cases[${index}]`));
        const ack = cases.find(event => event.id === 'sender-ack-only')!;
        const ackPayload = asObject(ack.payload, 'sender ack payload');
        assert.equal(ack.expectedClassification, 'sender-ack');
        assert.equal(ackPayload.op, undefined);
        assert.deepEqual(Object.keys(ackPayload).sort(), ['doc', 'v']);

        const duplicate = cases.find(event => event.id === 'duplicate-source-update')!;
        const retry = asObject(duplicate.retryUpdate, 'retry update');
        const applied = asObject(duplicate.duplicateAppliedEvent, 'duplicate applied event');
        assert.deepEqual(retry.dupIfSource, ['source-fixture']);
        assert.equal(applied.dup, true);
        assert.equal(duplicate.expectedCollaboratorDeliveryCount, 0);
    });

    it('marks REST history diff as a wrong-surface control', () => {
        const restDiff = fixtures.get('rest-diff.json')!;
        assert.equal(restDiff.surface, 'project-history-rest-diff');
        const raw = asObject(restDiff.raw, 'rest diff raw');
        assert.ok(Array.isArray(raw.diff));
        assert.equal(raw.textOperation, undefined);
        assert.ok(!Array.isArray(restDiff.raw), 'REST response is not a realtime operation array');
        for (const fixture of fixtures.values()) {
            if (fixture !== restDiff) {
                assert.equal(fixture.surface, 'realtime-history-ot');
            }
        }
    });

    it('labels unknown snapshot metadata as opaque rather than extending the official schema', () => {
        const unsafe = fixtures.get('unsafe.json')!;
        const rawCase = asArray(unsafe.cases, 'unsafe.cases')
            .map((item, index) => asObject(item, `unsafe.cases[${index}]`))
            .find(item => item.id === 'opaque-snapshot-fields-preserved-but-unsafe')!;
        assert.deepEqual(rawCase.opaquePaths, [
            '$.futureSnapshotMeta',
            '$.comments[0].thread',
            '$.comments[0].ranges[0].futureAnchor',
        ]);
        const raw = asObject(rawCase.raw, 'opaque snapshot');
        const comment = asObject(asArray(raw.comments, 'opaque comments')[0], 'opaque comment');
        const range = asObject(asArray(comment.ranges, 'opaque ranges')[0], 'opaque range');
        assert.deepEqual(raw.futureSnapshotMeta, {version: 2, mode: 'opaque'});
        assert.deepEqual(comment.thread, {status: 'opaque', token: 'opaque-thread'});
        assert.deepEqual(range.futureAnchor, {bias: 'after', token: 'opaque-anchor'});
    });

    it('keeps every unsafe example labelled for fail-closed integration checks', () => {
        const unsafe = fixtures.get('unsafe.json')!;
        const cases = asArray(unsafe.cases, 'unsafe.cases');
        assert.ok(cases.length >= 6);
        for (const [index, rawCase] of cases.entries()) {
            const fixtureCase = asObject(rawCase, `unsafe.cases[${index}]`);
            assert.equal(fixtureCase.expectedFailure, 'protocol-error');
            assert.ok(['operations', 'snapshot', 'apply'].includes(
                asString(fixtureCase.inputKind, `unsafe.cases[${index}].inputKind`),
            ));
        }
    });
});
