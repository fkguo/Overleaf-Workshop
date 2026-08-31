import {strict as assert} from 'assert';
import {readFileSync} from 'fs';
import path = require('path');

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
interface JsonObject {
    [key: string]: JsonValue,
}

interface TextEdit {
    pos: number,
    deleteLength?: number,
    insertText?: string,
    tracking?: {userId: string, ts: string},
}

interface Range {
    pos: number,
    length: number,
}

interface HistoryOtModule {
    parseHistoryOtSnapshot(input: unknown): unknown,
    serializeHistoryOtSnapshot(input: unknown): unknown,
    assertHistoryOtSnapshotSafe(input: unknown): void,
    parseHistoryOtOperations(input: unknown): unknown,
    serializeHistoryOtOperations(input: unknown): unknown,
    assertHistoryOtOperationsSafe(input: unknown): void,
    applyHistoryOtOperations(snapshot: unknown, operations: unknown): unknown,
    composeHistoryOtOperations(first: unknown, second: unknown): unknown,
    transformHistoryOtOperations(first: unknown, second: unknown): [unknown, unknown],
    invertHistoryOtOperations(snapshot: unknown, operations: unknown): unknown,
    getVisibleHistoryOtText(snapshot: unknown): string,
    snapshotOffsetToVisible(snapshot: unknown, offset: number): number,
    visibleOffsetToSnapshot(snapshot: unknown, offset: number, affinity?: 'left' | 'right'): number,
    buildHistoryOtTextUpdate(snapshot: unknown, edits: readonly TextEdit[]): unknown,
    buildAcceptTrackedChangesOperation(snapshot: unknown, ranges: readonly Range[]): unknown,
    buildRejectTrackedChangesOperation(snapshot: unknown, ranges: readonly Range[]): unknown,
}

// Deliberately use a narrow CommonJS interface: the implementation lands on the core branch.
const historyOt = require('../core/historyOt') as HistoryOtModule;
const fixtureDirectory = path.resolve(process.cwd(), 'src/test/fixtures/history-ot');
const propertyCaseCount = 128;

function loadFixture(name: string): JsonObject {
    const value = JSON.parse(readFileSync(path.join(fixtureDirectory, name), 'utf8')) as unknown;
    return asObject(value, name);
}

function asJson(value: unknown, label: string): JsonValue {
    const serialized = JSON.stringify(value);
    assert.notEqual(serialized, undefined, `${label} must be JSON-compatible`);
    return JSON.parse(serialized!) as JsonValue;
}

function asObject(value: unknown, label: string): JsonObject {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value),
        `${label} must be an object`);
    return value as JsonObject;
}

function asArray(value: unknown, label: string): JsonValue[] {
    assert.ok(Array.isArray(value), `${label} must be an array`);
    return value as JsonValue[];
}

function asString(value: unknown, label: string): string {
    assert.equal(typeof value, 'string', `${label} must be a string`);
    return value as string;
}

function asNumber(value: unknown, label: string): number {
    assert.equal(typeof value, 'number', `${label} must be a number`);
    return value as number;
}

function rawSnapshot(input: unknown): JsonObject {
    return asObject(asJson(historyOt.serializeHistoryOtSnapshot(input), 'serialized snapshot'), 'snapshot');
}

function rawOperations(input: unknown): JsonValue[] {
    return asArray(asJson(historyOt.serializeHistoryOtOperations(input), 'serialized operations'), 'operations');
}

function parsedSnapshot(raw: JsonValue): unknown {
    return historyOt.parseHistoryOtSnapshot(raw);
}

function parsedOperations(raw: JsonValue): unknown {
    const parsed = historyOt.parseHistoryOtOperations(raw);
    historyOt.assertHistoryOtOperationsSafe(parsed);
    return parsed;
}

function diagnostic(seed: number, caseIndex: number, details: JsonObject): string {
    return JSON.stringify({seed, caseIndex, ...details});
}

class SeededRandom {
    constructor(private state: number) {}

    nextUint32(): number {
        this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
        return this.state;
    }

    int(exclusiveMaximum: number): number {
        assert.ok(exclusiveMaximum > 0);
        return this.nextUint32() % exclusiveMaximum;
    }

    bool(numerator = 1, denominator = 2): boolean {
        return this.int(denominator) < numerator;
    }

    pick<T>(values: readonly T[]): T {
        return values[this.int(values.length)];
    }
}

const bmpTokens = ['a', 'Z', 'β', '中', 'e', '\u0301', '\r\n', '\n', ' '] as const;

function randomBmpText(random: SeededRandom, maximumTokens = 18, allowEmpty = true): string {
    const tokenCount = (allowEmpty ? 0 : 1) + random.int(maximumTokens + (allowEmpty ? 1 : 0));
    let result = '';
    for (let index = 0; index < tokenCount; index += 1) {
        result += random.pick(bmpTokens);
    }
    return result;
}

function generateTextOperation(base: string, random: SeededRandom): JsonValue[] {
    const scans: JsonValue[] = [];
    let cursor = 0;
    while (cursor < base.length) {
        if (random.bool(1, 3)) {
            scans.push(randomBmpText(random, 3, false));
        }
        const length = 1 + random.int(Math.min(4, base.length - cursor));
        scans.push(random.bool(3, 5) ? length : -length);
        cursor += length;
    }
    if (random.bool(1, 3)) {
        scans.push(randomBmpText(random, 3, false));
    }
    return [{textOperation: scans}];
}

function applyNaiveTextOperation(base: string, operations: JsonValue): string {
    let current = base;
    for (const [operationIndex, rawOperation] of asArray(operations, 'operations').entries()) {
        const operation = asObject(rawOperation, `operations[${operationIndex}]`);
        if (operation.textOperation === undefined) {
            continue;
        }
        let cursor = 0;
        let result = '';
        for (const [scanIndex, rawScan] of asArray(
            operation.textOperation, `operations[${operationIndex}].textOperation`,
        ).entries()) {
            if (typeof rawScan === 'number') {
                assert.notEqual(rawScan, 0);
                if (rawScan > 0) {
                    result += current.slice(cursor, cursor + rawScan);
                    cursor += rawScan;
                } else {
                    cursor -= rawScan;
                }
            } else if (typeof rawScan === 'string') {
                result += rawScan;
            } else {
                const scan = asObject(rawScan, `scan[${scanIndex}]`);
                if (typeof scan.i === 'string') {
                    result += scan.i;
                } else {
                    const retain = asNumber(scan.r, `scan[${scanIndex}].r`);
                    result += current.slice(cursor, cursor + retain);
                    cursor += retain;
                }
            }
        }
        assert.equal(cursor, current.length, `operation ${operationIndex} must consume its base`);
        current = result;
    }
    return current;
}

function assertProtocolError(block: () => void, label: string): void {
    assert.throws(block, (error: unknown) => {
        assert.ok(error instanceof Error, `${label} must throw an Error`);
        assert.equal(error.name, 'HistoryOtProtocolError', `${label} must fail closed`);
        return true;
    });
}

function generateTrackedDeleteSnapshot(random: SeededRandom): JsonObject {
    const length = 6 + random.int(20);
    let content = '';
    for (let index = 0; index < length; index += 1) {
        content += random.pick(['a', 'β', '中', '\r', '\n']);
    }
    const trackedChanges: JsonObject[] = [];
    let cursor = 0;
    while (cursor < content.length) {
        if (random.bool(1, 4)) {
            const deleteLength = 1 + random.int(Math.min(3, content.length - cursor));
            trackedChanges.push({
                range: {pos: cursor, length: deleteLength},
                tracking: {
                    type: 'delete',
                    userId: `user-${trackedChanges.length}`,
                    ts: `2026-01-02T03:04:${String(10 + trackedChanges.length).padStart(2, '0')}.000Z`,
                },
            });
            cursor += deleteLength + 1;
        } else {
            cursor += 1;
        }
    }
    if (trackedChanges.length === 0) {
        trackedChanges.push({
            range: {pos: random.int(content.length), length: 1},
            tracking: {
                type: 'delete',
                userId: 'user-0',
                ts: '2026-01-02T03:04:10.000Z',
            },
        });
    }
    return {content, trackedChanges};
}

function rawTrackedDeleteRanges(snapshot: JsonObject): Range[] {
    const rawChanges = snapshot.trackedChanges === undefined
        ? []
        : asArray(snapshot.trackedChanges, 'raw tracked changes');
    return rawChanges.flatMap((rawChange, index) => {
        const change = asObject(rawChange, `raw tracked change ${index}`);
        const tracking = asObject(change.tracking, `raw tracked change ${index}.tracking`);
        if (tracking.type !== 'delete') {
            return [];
        }
        const range = asObject(change.range, `raw tracked change ${index}.range`);
        return [{
            pos: asNumber(range.pos, 'raw range.pos'),
            length: asNumber(range.length, 'raw range.length'),
        }];
    }).sort((left, right) => left.pos - right.pos);
}

function rawSnapshotOffsetToVisible(snapshot: JsonObject, offset: number): number {
    let hiddenLength = 0;
    for (const range of rawTrackedDeleteRanges(snapshot)) {
        if (offset < range.pos) {
            break;
        }
        if (offset <= range.pos + range.length) {
            return range.pos - hiddenLength;
        }
        hiddenLength += range.length;
    }
    return offset - hiddenLength;
}

function rawVisibleOffsetToSnapshot(
    snapshot: JsonObject,
    offset: number,
    affinity: 'left' | 'right',
): number {
    let hiddenLength = 0;
    for (const range of rawTrackedDeleteRanges(snapshot)) {
        const boundary = range.pos - hiddenLength;
        if (affinity === 'left' ? offset <= boundary : offset < boundary) {
            return offset + hiddenLength;
        }
        hiddenLength += range.length;
    }
    return offset + hiddenLength;
}

describe('source-derived History OT behavior', () => {
    const snapshotsFixture = loadFixture('snapshots.json');
    const operationsFixture = loadFixture('operations.json');
    const unsafeFixture = loadFixture('unsafe.json');
    const restDiffFixture = loadFixture('rest-diff.json');

    it('round-trips snapshot and operation metadata without mutating fixture inputs', () => {
        for (const [index, rawCase] of asArray(snapshotsFixture.cases, 'snapshot cases').entries()) {
            const fixtureCase = asObject(rawCase, `snapshot case ${index}`);
            const original = asJson(fixtureCase.raw, 'snapshot fixture');
            assert.deepEqual(rawSnapshot(parsedSnapshot(original)), original);
            assert.deepEqual(fixtureCase.raw, original);
        }
        for (const [index, rawCase] of asArray(operationsFixture.applyCases, 'apply cases').entries()) {
            const fixtureCase = asObject(rawCase, `apply case ${index}`);
            const original = asJson(fixtureCase.rawOperations, 'operation fixture');
            assert.deepEqual(rawOperations(parsedOperations(original)), original);
            assert.deepEqual(fixtureCase.rawOperations, original);
        }
    });

    it('applies source-derived text, tracked-change, and comment fixtures', () => {
        for (const [index, rawCase] of asArray(operationsFixture.applyCases, 'apply cases').entries()) {
            const fixtureCase = asObject(rawCase, `apply case ${index}`);
            const result = historyOt.applyHistoryOtOperations(
                parsedSnapshot(asJson(fixtureCase.baseSnapshot, 'base snapshot')),
                parsedOperations(asJson(fixtureCase.rawOperations, 'raw operations')),
            );
            assert.deepEqual(rawSnapshot(result), fixtureCase.expectedSnapshot, `apply fixture ${fixtureCase.id}`);
            assert.equal(historyOt.getVisibleHistoryOtText(result), fixtureCase.expectedVisibleText);
        }

        const lifecycle = asObject(operationsFixture.commentLifecycle, 'comment lifecycle');
        let snapshot = parsedSnapshot(asJson(lifecycle.baseSnapshot, 'comment base snapshot'));
        for (const [index, rawStep] of asArray(lifecycle.steps, 'comment steps').entries()) {
            const step = asObject(rawStep, `comment step ${index}`);
            snapshot = historyOt.applyHistoryOtOperations(
                snapshot,
                parsedOperations(asJson(step.rawOperations, 'comment operations')),
            );
            assert.deepEqual(rawSnapshot(snapshot), step.expectedSnapshot, `comment step ${step.name}`);
        }
    });

    it('recovers source-derived comment and tracked-change metadata with generated inverses', () => {
        for (const [index, rawCase] of asArray(operationsFixture.applyCases, 'apply cases').entries()) {
            const fixtureCase = asObject(rawCase, `apply case ${index}`);
            const expectedBase = asJson(fixtureCase.baseSnapshot, 'base snapshot');
            const snapshot = parsedSnapshot(expectedBase);
            const operations = parsedOperations(asJson(fixtureCase.rawOperations, 'raw operations'));
            const inverse = historyOt.invertHistoryOtOperations(snapshot, operations);
            const after = historyOt.applyHistoryOtOperations(snapshot, operations);
            const recovered = historyOt.applyHistoryOtOperations(after, inverse);
            assert.deepEqual(rawSnapshot(recovered), expectedBase, `inverse fixture ${fixtureCase.id}`);
        }

    });

    it('canonically restores an unresolved comment with a generated state inverse', () => {
        const lifecycle = asObject(operationsFixture.commentLifecycle, 'comment lifecycle');
        const steps = asArray(lifecycle.steps, 'comment steps');
        const added = asObject(steps[0], 'comment add step');
        const resolve = asObject(steps[1], 'comment resolve step');
        const expectedUnresolved = asJson(added.expectedSnapshot, 'unresolved comment snapshot');
        const snapshot = parsedSnapshot(expectedUnresolved);
        const operations = parsedOperations(asJson(resolve.rawOperations, 'resolve operations'));
        const inverse = historyOt.invertHistoryOtOperations(snapshot, operations);
        const after = historyOt.applyHistoryOtOperations(snapshot, operations);
        const recovered = historyOt.applyHistoryOtOperations(after, inverse);
        assert.deepEqual(rawSnapshot(recovered), expectedUnresolved);
    });

    it('builds official accept and reject operations for adjacent tracked changes', () => {
        const decisions = asObject(operationsFixture.trackedChangeDecisions, 'tracked decisions');
        const snapshot = parsedSnapshot(asJson(decisions.baseSnapshot, 'decision snapshot'));
        const ranges = asArray(decisions.changes, 'selected changes').map((rawChange, index) => {
            const change = asObject(rawChange, `change ${index}`);
            const range = asObject(change.range, `change ${index}.range`);
            return {pos: asNumber(range.pos, 'range.pos'), length: asNumber(range.length, 'range.length')};
        });
        const accept = historyOt.buildAcceptTrackedChangesOperation(snapshot, ranges);
        const reject = historyOt.buildRejectTrackedChangesOperation(snapshot, ranges);
        assert.deepEqual(rawOperations(accept), decisions.expectedAcceptOperations);
        assert.deepEqual(rawOperations(reject), decisions.expectedRejectOperations);
        assert.deepEqual(
            rawSnapshot(historyOt.applyHistoryOtOperations(snapshot, accept)),
            decisions.expectedAcceptedSnapshot,
        );
        assert.deepEqual(
            rawSnapshot(historyOt.applyHistoryOtOperations(snapshot, reject)),
            decisions.expectedRejectedSnapshot,
        );
    });

    it('maps every source-derived visible/snapshot boundary with left affinity', () => {
        const cases = asArray(snapshotsFixture.cases, 'snapshot cases');
        const fixtureCase = asObject(cases[1], 'tracked snapshot fixture');
        const snapshot = parsedSnapshot(asJson(fixtureCase.raw, 'tracked snapshot'));
        for (const rawMapping of asArray(fixtureCase.snapshotToVisible, 'snapshot mappings')) {
            const mapping = asObject(rawMapping, 'snapshot mapping');
            assert.equal(
                historyOt.snapshotOffsetToVisible(snapshot, asNumber(mapping.input, 'input')),
                mapping.expected,
            );
        }
        for (const rawMapping of asArray(fixtureCase.visibleToSnapshot, 'visible mappings')) {
            const mapping = asObject(rawMapping, 'visible mapping');
            assert.equal(
                historyOt.visibleOffsetToSnapshot(snapshot, asNumber(mapping.input, 'input')),
                mapping.expected,
            );
        }
        assert.equal(historyOt.visibleOffsetToSnapshot(snapshot, 7, 'right'), 10);
    });

    it('builds a snapshot-coordinate edit at a hidden tracked-delete boundary', () => {
        const fixtureCase = asObject(operationsFixture.visibleTextUpdate, 'visible text update');
        const snapshot = parsedSnapshot(asJson(fixtureCase.baseSnapshot, 'visible update snapshot'));
        const edits = asArray(fixtureCase.edits, 'visible update edits').map((rawEdit, index) => {
            const edit = asObject(rawEdit, `edit ${index}`);
            return {pos: asNumber(edit.pos, 'edit.pos'), insertText: asString(edit.insertText, 'edit.insertText')};
        });
        const update = historyOt.buildHistoryOtTextUpdate(snapshot, edits);
        assert.deepEqual(rawOperations(update), fixtureCase.expectedOperations);
        const result = historyOt.applyHistoryOtOperations(snapshot, update);
        assert.equal(historyOt.getVisibleHistoryOtText(result), fixtureCase.desiredVisibleText);
    });

    it('enforces official rejections and the stricter adapter safety policy', () => {
        for (const [index, rawCase] of asArray(unsafeFixture.cases, 'unsafe cases').entries()) {
            const fixtureCase = asObject(rawCase, `unsafe case ${index}`);
            const expectationBasis = asString(fixtureCase.expectationBasis, 'expectationBasis');
            assert.ok(['official-runtime-rejection', 'adapter-safety-policy'].includes(expectationBasis));
            if (expectationBasis === 'adapter-safety-policy') {
                assert.ok(asString(fixtureCase.adapterPolicy, 'adapterPolicy').length > 0);
            }
            const kind = asString(fixtureCase.inputKind, 'inputKind');
            if (kind === 'operations') {
                assertProtocolError(() => {
                    const parsed = historyOt.parseHistoryOtOperations(fixtureCase.raw);
                    historyOt.assertHistoryOtOperationsSafe(parsed);
                }, asString(fixtureCase.id, 'unsafe id'));
            } else if (kind === 'snapshot') {
                assertProtocolError(() => {
                    historyOt.getVisibleHistoryOtText(historyOt.parseHistoryOtSnapshot(fixtureCase.raw));
                }, asString(fixtureCase.id, 'unsafe id'));
            } else {
                assertProtocolError(() => {
                    historyOt.applyHistoryOtOperations(
                        historyOt.parseHistoryOtSnapshot(fixtureCase.baseSnapshot),
                        historyOt.parseHistoryOtOperations(fixtureCase.raw),
                    );
                }, asString(fixtureCase.id, 'unsafe id'));
            }
        }
        assertProtocolError(() => {
            const parsed = historyOt.parseHistoryOtOperations(restDiffFixture.raw);
            historyOt.assertHistoryOtOperationsSafe(parsed);
        }, 'Project History REST diff');
        assertProtocolError(() => {
            historyOt.buildHistoryOtTextUpdate(
                historyOt.parseHistoryOtSnapshot({content: ''}),
                [{pos: 0, insertText: '😀'}],
            );
        }, 'non-BMP text-update builder');
    });

    it('preserves opaque fields losslessly under the adapter safety policy', () => {
        const rawCase = asArray(unsafeFixture.cases, 'unsafe cases')
            .map((item, index) => asObject(item, `unsafe case ${index}`))
            .find(item => item.id === 'opaque-snapshot-fields-preserved-but-unsafe')!;
        assert.equal(rawCase.expectationBasis, 'adapter-safety-policy');
        const original = asJson(rawCase.raw, 'opaque snapshot');
        const parsed = historyOt.parseHistoryOtSnapshot(original);
        assert.deepEqual(rawSnapshot(parsed), original);
        assert.deepEqual(rawCase.raw, original);
        assertProtocolError(() => {
            historyOt.assertHistoryOtSnapshotSafe(parsed);
        }, 'opaque snapshot safety gate');
        assertProtocolError(() => {
            historyOt.applyHistoryOtOperations(parsed, parsedOperations([]));
        }, 'opaque snapshot apply gate');
    });
});

describe('deterministic History OT algebraic properties', () => {
    const operationsFixture = loadFixture('operations.json');

    it('uses the official operation1 tie-break and converges with concurrent deletion', () => {
        const tieBreak = asObject(operationsFixture.samePositionInsertTransform, 'insert tie-break');
        const snapshot = parsedSnapshot(asJson(tieBreak.baseSnapshot, 'tie-break snapshot'));
        const operation1 = parsedOperations(asJson(tieBreak.operation1, 'operation1'));
        const operation2 = parsedOperations(asJson(tieBreak.operation2, 'operation2'));
        const [operation1Prime, operation2Prime] = historyOt.transformHistoryOtOperations(
            operation1, operation2,
        );
        assert.deepEqual(rawOperations(operation1Prime), tieBreak.expectedOperation1Prime);
        assert.deepEqual(rawOperations(operation2Prime), tieBreak.expectedOperation2Prime);
        const operation1Then2Prime = historyOt.applyHistoryOtOperations(
            historyOt.applyHistoryOtOperations(snapshot, operation1), operation2Prime,
        );
        const operation2Then1Prime = historyOt.applyHistoryOtOperations(
            historyOt.applyHistoryOtOperations(snapshot, operation2), operation1Prime,
        );
        assert.deepEqual(rawSnapshot(operation1Then2Prime), tieBreak.expectedSnapshot);
        assert.deepEqual(rawSnapshot(operation2Then1Prime), tieBreak.expectedSnapshot);

        const concurrentSnapshot = parsedSnapshot({content: 'abcdef'});
        const left = parsedOperations([{textOperation: [1, -3, 2]}]);
        const right = parsedOperations([{textOperation: [2, 'X', 4]}]);
        const [leftPrime, rightPrime] = historyOt.transformHistoryOtOperations(left, right);
        assert.deepEqual(
            rawSnapshot(historyOt.applyHistoryOtOperations(
                historyOt.applyHistoryOtOperations(concurrentSnapshot, left), rightPrime,
            )),
            rawSnapshot(historyOt.applyHistoryOtOperations(
                historyOt.applyHistoryOtOperations(concurrentSnapshot, right), leftPrime,
            )),
        );
    });

    it('round-trips generated BMP, CRLF, and combining-mark operations', () => {
        const seed = 0x13579bdf;
        const random = new SeededRandom(seed);
        for (let caseIndex = 0; caseIndex < propertyCaseCount; caseIndex += 1) {
            const content = randomBmpText(random);
            const snapshot: JsonObject = {content};
            const operations = generateTextOperation(content, random);
            const beforeSnapshot = asJson(snapshot, 'snapshot copy');
            const beforeOperations = asJson(operations, 'operations copy');
            const message = diagnostic(seed, caseIndex, {snapshot, operations});
            assert.deepEqual(rawSnapshot(parsedSnapshot(snapshot)), snapshot, message);
            assert.deepEqual(rawOperations(parsedOperations(operations)), operations, message);
            assert.deepEqual(snapshot, beforeSnapshot, message);
            assert.deepEqual(operations, beforeOperations, message);
        }
    });

    it('agrees with a narrow independent executor for plain text apply', () => {
        const seed = 0x2468ace0;
        const random = new SeededRandom(seed);
        for (let caseIndex = 0; caseIndex < propertyCaseCount; caseIndex += 1) {
            const content = randomBmpText(random);
            const operations = generateTextOperation(content, random);
            const expected = applyNaiveTextOperation(content, operations);
            const result = historyOt.applyHistoryOtOperations(
                parsedSnapshot({content}), parsedOperations(operations),
            );
            assert.equal(
                rawSnapshot(result).content,
                expected,
                diagnostic(seed, caseIndex, {content, operations}),
            );
        }
    });

    it('satisfies sequential apply equals composed apply', () => {
        const seed = 0x10293847;
        const random = new SeededRandom(seed);
        for (let caseIndex = 0; caseIndex < propertyCaseCount; caseIndex += 1) {
            const content = randomBmpText(random);
            const firstRaw = generateTextOperation(content, random);
            const afterFirstText = applyNaiveTextOperation(content, firstRaw);
            const secondRaw = generateTextOperation(afterFirstText, random);
            const snapshot = parsedSnapshot({content});
            const first = parsedOperations(firstRaw);
            const second = parsedOperations(secondRaw);
            const sequential = historyOt.applyHistoryOtOperations(
                historyOt.applyHistoryOtOperations(snapshot, first), second,
            );
            const composed = historyOt.composeHistoryOtOperations(first, second);
            const direct = historyOt.applyHistoryOtOperations(snapshot, composed);
            assert.deepEqual(
                rawSnapshot(direct),
                rawSnapshot(sequential),
                diagnostic(seed, caseIndex, {content, firstRaw, secondRaw}),
            );
        }
    });

    it('converges after transforming concurrent insert/delete operations', () => {
        const seed = 0x55667788;
        const random = new SeededRandom(seed);
        for (let caseIndex = 0; caseIndex < propertyCaseCount; caseIndex += 1) {
            const content = randomBmpText(random);
            const leftRaw = generateTextOperation(content, random);
            const rightRaw = generateTextOperation(content, random);
            const snapshot = parsedSnapshot({content});
            const left = parsedOperations(leftRaw);
            const right = parsedOperations(rightRaw);
            const [leftPrime, rightPrime] = historyOt.transformHistoryOtOperations(left, right);
            const leftThenRight = historyOt.applyHistoryOtOperations(
                historyOt.applyHistoryOtOperations(snapshot, left), rightPrime,
            );
            const rightThenLeft = historyOt.applyHistoryOtOperations(
                historyOt.applyHistoryOtOperations(snapshot, right), leftPrime,
            );
            assert.deepEqual(
                rawSnapshot(leftThenRight),
                rawSnapshot(rightThenLeft),
                diagnostic(seed, caseIndex, {content, leftRaw, rightRaw}),
            );
        }
    });

    it('recovers the original snapshot with the generated inverse', () => {
        const seed = 0x90abcdef;
        const random = new SeededRandom(seed);
        for (let caseIndex = 0; caseIndex < propertyCaseCount; caseIndex += 1) {
            const content = randomBmpText(random);
            const operationsRaw = generateTextOperation(content, random);
            const snapshot = parsedSnapshot({content});
            const operations = parsedOperations(operationsRaw);
            const inverse = historyOt.invertHistoryOtOperations(snapshot, operations);
            const after = historyOt.applyHistoryOtOperations(snapshot, operations);
            const recovered = historyOt.applyHistoryOtOperations(after, inverse);
            assert.deepEqual(
                rawSnapshot(recovered),
                {content},
                diagnostic(seed, caseIndex, {content, operationsRaw}),
            );
        }
    });

    it('keeps offset maps monotone and right-invertible across tracked deletes', () => {
        const seed = 0xa5a5a5a5;
        const random = new SeededRandom(seed);
        for (let caseIndex = 0; caseIndex < propertyCaseCount; caseIndex += 1) {
            const raw = generateTrackedDeleteSnapshot(random);
            const snapshot = parsedSnapshot(raw);
            const contentLength = asString(raw.content, 'content').length;
            const hiddenLength = rawTrackedDeleteRanges(raw)
                .reduce((total, range) => total + range.length, 0);
            const visibleLength = contentLength - hiddenLength;
            let previous = -1;
            for (let offset = 0; offset <= contentLength; offset += 1) {
                const mapped = historyOt.snapshotOffsetToVisible(snapshot, offset);
                const message = diagnostic(seed, caseIndex, {snapshot: raw, offset, mapped});
                assert.equal(mapped, rawSnapshotOffsetToVisible(raw, offset), message);
                assert.ok(mapped >= previous, message);
                assert.ok(mapped >= 0 && mapped <= visibleLength, message);
                previous = mapped;
            }
            for (let offset = 0; offset <= visibleLength; offset += 1) {
                const snapshotOffset = historyOt.visibleOffsetToSnapshot(snapshot, offset, 'left');
                const rightSnapshotOffset = historyOt.visibleOffsetToSnapshot(snapshot, offset, 'right');
                const message = diagnostic(seed, caseIndex, {snapshot: raw, offset, snapshotOffset});
                assert.equal(snapshotOffset, rawVisibleOffsetToSnapshot(raw, offset, 'left'), message);
                assert.equal(rightSnapshotOffset, rawVisibleOffsetToSnapshot(raw, offset, 'right'), message);
                assert.equal(
                    rawSnapshotOffsetToVisible(raw, snapshotOffset),
                    offset,
                    message,
                );
            }
        }
    });

    it('preserves tracked insert/delete metadata in builder wire and snapshot output', () => {
        const fixtureCase = asObject(operationsFixture.trackedTextUpdate, 'tracked text update');
        const rawEdit = asObject(fixtureCase.edit, 'tracked edit');
        const rawTracking = asObject(rawEdit.tracking, 'tracked edit tracking');
        const edit: TextEdit = {
            pos: asNumber(rawEdit.pos, 'tracked edit.pos'),
            deleteLength: asNumber(rawEdit.deleteLength, 'tracked edit.deleteLength'),
            insertText: asString(rawEdit.insertText, 'tracked edit.insertText'),
            tracking: {
                userId: asString(rawTracking.userId, 'tracked edit userId'),
                ts: asString(rawTracking.ts, 'tracked edit timestamp'),
            },
        };
        const snapshot = parsedSnapshot(asJson(fixtureCase.baseSnapshot, 'tracked builder snapshot'));
        const operations = historyOt.buildHistoryOtTextUpdate(snapshot, [edit]);
        assert.deepEqual(rawOperations(operations), fixtureCase.expectedOperations);
        const result = historyOt.applyHistoryOtOperations(snapshot, operations);
        assert.deepEqual(rawSnapshot(result), fixtureCase.expectedSnapshot);
        assert.equal(historyOt.getVisibleHistoryOtText(result), fixtureCase.expectedVisibleText);
    });

    it('builds plain and tracked source-coordinate edits with the requested visible result', () => {
        const seed = 0xcafef00d;
        const random = new SeededRandom(seed);
        for (let caseIndex = 0; caseIndex < propertyCaseCount; caseIndex += 1) {
            const content = randomBmpText(random, 18, false);
            const pos = random.int(content.length + 1);
            const deleteLength = random.int(Math.min(4, content.length - pos) + 1);
            const insertText = randomBmpText(random, 3);
            const tracked = caseIndex % 2 === 1;
            const edit: TextEdit = {pos, deleteLength, insertText};
            if (tracked) {
                edit.tracking = {
                    userId: 'user-property',
                    ts: '2026-01-02T03:04:05.000Z',
                };
            }
            const snapshot = parsedSnapshot({content});
            const update = historyOt.buildHistoryOtTextUpdate(snapshot, [edit]);
            const result = historyOt.applyHistoryOtOperations(snapshot, update);
            const expected = content.slice(0, pos) + insertText + content.slice(pos + deleteLength);
            assert.equal(
                historyOt.getVisibleHistoryOtText(result),
                expected,
                diagnostic(seed, caseIndex, {content, edit: asJson(edit, 'edit')}),
            );
        }
    });
});
