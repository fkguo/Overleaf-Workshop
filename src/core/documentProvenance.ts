import { createHash, randomUUID } from 'crypto';

export const DOCUMENT_PROVENANCE_SCHEMA_VERSION = 2 as const;

const RECORD_NAMESPACE = 'document-provenance';
const RECORD_SUFFIX = '.json';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | {[key: string]: JsonValue};

/**
 * Storage adapters must atomically replace each named byte array. A resolved
 * write/delete promise is the durability point for that operation.
 */
export interface ProvenanceStorage {
    list(): Promise<string[]>;
    read(recordName: string): Promise<Uint8Array | undefined>;
    write(recordName: string, content: Uint8Array): Promise<void>;
    delete(recordName: string): Promise<void>;
}

export type DocumentProvenanceStorage = ProvenanceStorage;

export interface DocumentProvenanceIdentity {
    canonicalServerUrl: string;
    userId: string;
    projectId: string;
    docId: string;
    canonicalEditorUri: string;
    otType: string;
    protocolVersion: number;
}

export interface DocumentProvenanceRecord {
    schemaVersion: typeof DOCUMENT_PROVENANCE_SCHEMA_VERSION;
    recordName: string;
    identity: DocumentProvenanceIdentity;
    identityHash: string;
    bufferIncarnationId: string;
    baseVersion: number;
    baseText: string;
    baseHash: string;
    dirtyText: string;
    dirtyHash: string;
    updatedAt: number;
    pendingWrite?: JsonValue;
}

export interface DirtyDocumentProvenance {
    identity: DocumentProvenanceIdentity;
    bufferIncarnationId: string;
    baseVersion: number;
    baseText: string;
    dirtyText: string;
}

export interface CurrentRecordExpectation {
    identity: DocumentProvenanceIdentity;
    bufferIncarnationId: string;
    baseVersion?: number;
    baseText?: string;
    dirtyText?: string;
}

export type DocumentProvenanceInvalidReason =
    | 'not-current-session'
    | 'corrupt-encoding'
    | 'corrupt-json'
    | 'unknown-schema'
    | 'invalid-record'
    | 'record-name-mismatch'
    | 'identity-mismatch'
    | 'identity-hash-mismatch'
    | 'buffer-incarnation-mismatch'
    | 'base-hash-mismatch'
    | 'dirty-hash-mismatch'
    | 'base-version-mismatch'
    | 'base-text-mismatch'
    | 'dirty-text-mismatch';

export type NamedDocumentProvenanceResolution =
    | {kind: 'valid', record: DocumentProvenanceRecord}
    | {kind: 'missing', recordName: string}
    | {kind: 'invalid', recordName: string, reason: DocumentProvenanceInvalidReason};

export type ColdDocumentProvenanceResolution =
    | {kind: 'valid', record: DocumentProvenanceRecord}
    | {kind: 'missing'}
    | {kind: 'ambiguous', recordNames: string[]}
    | {kind: 'invalid', recordName: string, reason: DocumentProvenanceInvalidReason};

export interface DocumentProvenanceStoreOptions {
    /** A fresh, process-session identifier. randomUUID() is used by default. */
    sessionId?: string;
    now?: () => number;
}

type ParsedRecord =
    | {kind: 'valid', record: DocumentProvenanceRecord}
    | {kind: 'missing'}
    | {kind: 'invalid', reason: DocumentProvenanceInvalidReason};

type DecodedJson =
    | {kind: 'valid', value: unknown}
    | {kind: 'invalid', reason: 'corrupt-encoding' | 'corrupt-json'};

function sha256Bytes(content: Uint8Array): string {
    return createHash('sha256').update(content).digest('hex');
}

export function sha256Text(content: string): string {
    return sha256Bytes(new TextEncoder().encode(content));
}

function requireNonEmptyString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${field} must be a non-empty string`);
    }
    return value;
}

function requireVersion(value: unknown, field: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`${field} must be a non-negative safe integer`);
    }
    return value as number;
}

export function canonicalizeServerUrl(value: string): string {
    const parsed = new URL(requireNonEmptyString(value, 'canonicalServerUrl'));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('canonicalServerUrl must use HTTP or HTTPS');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('canonicalServerUrl must not contain credentials, a query, or a fragment');
    }

    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${pathname}`;
}

export function canonicalizeDocumentIdentity(
    identity: DocumentProvenanceIdentity,
): DocumentProvenanceIdentity {
    return {
        canonicalServerUrl: canonicalizeServerUrl(identity.canonicalServerUrl),
        userId: requireNonEmptyString(identity.userId, 'userId'),
        projectId: requireNonEmptyString(identity.projectId, 'projectId'),
        docId: requireNonEmptyString(identity.docId, 'docId'),
        canonicalEditorUri: requireNonEmptyString(identity.canonicalEditorUri, 'canonicalEditorUri'),
        otType: requireNonEmptyString(identity.otType, 'otType'),
        protocolVersion: requireVersion(identity.protocolVersion, 'protocolVersion'),
    };
}

function identityTuple(identity: DocumentProvenanceIdentity): readonly (string | number)[] {
    const canonical = canonicalizeDocumentIdentity(identity);
    return [
        canonical.canonicalServerUrl,
        canonical.userId,
        canonical.projectId,
        canonical.docId,
        canonical.canonicalEditorUri,
        canonical.otType,
        canonical.protocolVersion,
    ];
}

export function documentProvenanceIdentityHash(identity: DocumentProvenanceIdentity): string {
    return sha256Text(JSON.stringify(identityTuple(identity)));
}

function recordPrefix(identityHash: string): string {
    return `${RECORD_NAMESPACE}.${identityHash}.`;
}

function recordNameFor(identityHash: string, sessionHash: string, bufferHash: string): string {
    return `${recordPrefix(identityHash)}${sessionHash}.${bufferHash}${RECORD_SUFFIX}`;
}

function identitiesEqual(
    left: DocumentProvenanceIdentity,
    right: DocumentProvenanceIdentity,
): boolean {
    return JSON.stringify(identityTuple(left)) === JSON.stringify(identityTuple(right));
}

function isObject(value: unknown): value is {[key: string]: unknown} {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return true;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value);
    }
    if (Array.isArray(value)) {
        return value.every(isJsonValue);
    }
    if (isObject(value)) {
        return Object.values(value).every(isJsonValue);
    }
    return false;
}

function hasOwn(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function readIdentity(value: unknown): DocumentProvenanceIdentity | undefined {
    if (!isObject(value)) {
        return undefined;
    }
    try {
        const canonical = canonicalizeDocumentIdentity({
            canonicalServerUrl: value.canonicalServerUrl as string,
            userId: value.userId as string,
            projectId: value.projectId as string,
            docId: value.docId as string,
            canonicalEditorUri: value.canonicalEditorUri as string,
            otType: value.otType as string,
            protocolVersion: value.protocolVersion as number,
        });
        if (canonical.canonicalServerUrl !== value.canonicalServerUrl) {
            return undefined;
        }
        return canonical;
    } catch {
        return undefined;
    }
}

function decodeJson(content: Uint8Array): DecodedJson {
    let text: string;
    try {
        text = new TextDecoder('utf-8', {fatal: true}).decode(content);
    } catch {
        return {kind: 'invalid', reason: 'corrupt-encoding'};
    }
    try {
        return {kind: 'valid', value: JSON.parse(text) as unknown};
    } catch {
        return {kind: 'invalid', reason: 'corrupt-json'};
    }
}

function validateRecord(value: unknown, expectedRecordName: string): ParsedRecord {
    if (!isObject(value)) {
        return {kind: 'invalid', reason: 'invalid-record'};
    }
    if (value.schemaVersion !== DOCUMENT_PROVENANCE_SCHEMA_VERSION) {
        return {kind: 'invalid', reason: 'unknown-schema'};
    }
    if (value.recordName !== expectedRecordName) {
        return {kind: 'invalid', reason: 'record-name-mismatch'};
    }

    const identity = readIdentity(value.identity);
    if (!identity || typeof value.identityHash !== 'string'
        || !SHA256_PATTERN.test(value.identityHash)) {
        return {kind: 'invalid', reason: 'invalid-record'};
    }
    const identityHash = documentProvenanceIdentityHash(identity);
    if (identityHash !== value.identityHash
        || !expectedRecordName.startsWith(recordPrefix(identityHash))
        || !expectedRecordName.endsWith(RECORD_SUFFIX)) {
        return {kind: 'invalid', reason: 'identity-hash-mismatch'};
    }
    if (typeof value.bufferIncarnationId !== 'string' || value.bufferIncarnationId.length === 0) {
        return {kind: 'invalid', reason: 'invalid-record'};
    }
    const bufferHash = sha256Text(value.bufferIncarnationId);
    if (!expectedRecordName.endsWith(`.${bufferHash}${RECORD_SUFFIX}`)) {
        return {kind: 'invalid', reason: 'buffer-incarnation-mismatch'};
    }

    if (!Number.isSafeInteger(value.baseVersion) || (value.baseVersion as number) < 0
        || typeof value.baseText !== 'string'
        || typeof value.baseHash !== 'string'
        || !SHA256_PATTERN.test(value.baseHash)
        || typeof value.dirtyText !== 'string'
        || typeof value.dirtyHash !== 'string'
        || !SHA256_PATTERN.test(value.dirtyHash)
        || !Number.isSafeInteger(value.updatedAt)
        || (value.updatedAt as number) < 0
        || (hasOwn(value, 'pendingWrite') && !isJsonValue(value.pendingWrite))) {
        return {kind: 'invalid', reason: 'invalid-record'};
    }
    if (sha256Text(value.baseText) !== value.baseHash) {
        return {kind: 'invalid', reason: 'base-hash-mismatch'};
    }
    if (sha256Text(value.dirtyText) !== value.dirtyHash) {
        return {kind: 'invalid', reason: 'dirty-hash-mismatch'};
    }

    const record: DocumentProvenanceRecord = {
        schemaVersion: DOCUMENT_PROVENANCE_SCHEMA_VERSION,
        recordName: expectedRecordName,
        identity,
        identityHash,
        bufferIncarnationId: value.bufferIncarnationId,
        baseVersion: value.baseVersion as number,
        baseText: value.baseText,
        baseHash: value.baseHash,
        dirtyText: value.dirtyText,
        dirtyHash: value.dirtyHash,
        updatedAt: value.updatedAt as number,
    };
    if (hasOwn(value, 'pendingWrite')) {
        record.pendingWrite = value.pendingWrite as JsonValue;
    }
    return {kind: 'valid', record};
}

function serializeRecord(record: DocumentProvenanceRecord): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(record));
}

function nextTimestamp(now: () => number, previous?: number): number {
    const current = now();
    if (!Number.isSafeInteger(current) || current < 0) {
        throw new Error('now() must return a non-negative safe integer');
    }
    return previous === undefined ? current : Math.max(current, previous + 1);
}

export class DocumentProvenanceStore {
    private readonly sessionHash: string;
    private readonly now: () => number;
    private operationTail: Promise<void> = Promise.resolve();

    constructor(
        private readonly storage: ProvenanceStorage,
        options: DocumentProvenanceStoreOptions = {},
    ) {
        const sessionId = options.sessionId ?? randomUUID();
        this.sessionHash = sha256Text(requireNonEmptyString(sessionId, 'sessionId'));
        this.now = options.now ?? Date.now;
    }

    currentRecordName(identity: DocumentProvenanceIdentity, bufferIncarnationId: string): string {
        const bufferHash = sha256Text(requireNonEmptyString(
            bufferIncarnationId,
            'bufferIncarnationId',
        ));
        return recordNameFor(documentProvenanceIdentityHash(identity), this.sessionHash, bufferHash);
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operationTail.then(operation);
        this.operationTail = result.then(() => undefined, () => undefined);
        return result;
    }

    private async readRecord(recordName: string): Promise<ParsedRecord> {
        const content = await this.storage.read(recordName);
        if (!content) {
            return {kind: 'missing'};
        }
        const decoded = decodeJson(content);
        if (decoded.kind === 'invalid') {
            return decoded;
        }
        return validateRecord(decoded.value, recordName);
    }

    private async writeRecord(record: DocumentProvenanceRecord): Promise<void> {
        await this.storage.write(record.recordName, serializeRecord(record));
    }

    private requireValidCurrent(recordName: string, parsed: ParsedRecord): DocumentProvenanceRecord {
        if (parsed.kind !== 'valid') {
            const reason = parsed.kind === 'invalid' ? parsed.reason : 'missing';
            throw new Error(`Cannot mutate provenance record ${recordName}: ${reason}`);
        }
        if (this.currentRecordName(
            parsed.record.identity,
            parsed.record.bufferIncarnationId,
        ) !== recordName) {
            throw new Error(`Cannot mutate provenance record ${recordName}: not-current-session`);
        }
        return parsed.record;
    }

    async createOrUpdateCurrent(input: DirtyDocumentProvenance): Promise<DocumentProvenanceRecord> {
        return this.enqueue(async () => {
            const identity = canonicalizeDocumentIdentity(input.identity);
            const bufferIncarnationId = requireNonEmptyString(
                input.bufferIncarnationId,
                'bufferIncarnationId',
            );
            const baseVersion = requireVersion(input.baseVersion, 'baseVersion');
            if (typeof input.baseText !== 'string' || typeof input.dirtyText !== 'string') {
                throw new Error('baseText and dirtyText must be strings');
            }

            const identityHash = documentProvenanceIdentityHash(identity);
            const recordName = recordNameFor(
                identityHash,
                this.sessionHash,
                sha256Text(bufferIncarnationId),
            );
            const parsed = await this.readRecord(recordName);
            let previous: DocumentProvenanceRecord | undefined;
            if (parsed.kind !== 'missing') {
                previous = this.requireValidCurrent(recordName, parsed);
            }
            if (previous && hasOwn(previous, 'pendingWrite')) {
                const exactPendingRecord = identitiesEqual(previous.identity, identity)
                    && previous.bufferIncarnationId === bufferIncarnationId
                    && previous.baseVersion === baseVersion
                    && previous.baseText === input.baseText
                    && previous.dirtyText === input.dirtyText;
                if (!exactPendingRecord) {
                    throw new Error(
                        `Cannot update provenance record ${recordName}: pending-write is immutable`,
                    );
                }
                return previous;
            }

            const record: DocumentProvenanceRecord = {
                schemaVersion: DOCUMENT_PROVENANCE_SCHEMA_VERSION,
                recordName,
                identity,
                identityHash,
                bufferIncarnationId,
                baseVersion,
                baseText: input.baseText,
                baseHash: sha256Text(input.baseText),
                dirtyText: input.dirtyText,
                dirtyHash: sha256Text(input.dirtyText),
                updatedAt: nextTimestamp(this.now, previous?.updatedAt),
            };
            await this.writeRecord(record);
            return record;
        });
    }

    async resolveCurrentRecord(
        recordName: string,
        expectation: CurrentRecordExpectation,
    ): Promise<NamedDocumentProvenanceResolution> {
        await this.flush();
        const identity = canonicalizeDocumentIdentity(expectation.identity);
        const bufferIncarnationId = requireNonEmptyString(
            expectation.bufferIncarnationId,
            'bufferIncarnationId',
        );
        if (recordName !== this.currentRecordName(identity, bufferIncarnationId)) {
            return {kind: 'invalid', recordName, reason: 'not-current-session'};
        }
        const parsed = await this.readRecord(recordName);
        if (parsed.kind === 'missing') {
            return {kind: 'missing', recordName};
        }
        if (parsed.kind === 'invalid') {
            return {kind: 'invalid', recordName, reason: parsed.reason};
        }
        if (!identitiesEqual(parsed.record.identity, identity)) {
            return {kind: 'invalid', recordName, reason: 'identity-mismatch'};
        }
        if (parsed.record.bufferIncarnationId !== bufferIncarnationId) {
            return {kind: 'invalid', recordName, reason: 'buffer-incarnation-mismatch'};
        }
        if (expectation.baseVersion !== undefined
            && parsed.record.baseVersion !== expectation.baseVersion) {
            return {kind: 'invalid', recordName, reason: 'base-version-mismatch'};
        }
        if (expectation.baseText !== undefined && parsed.record.baseText !== expectation.baseText) {
            return {kind: 'invalid', recordName, reason: 'base-text-mismatch'};
        }
        if (expectation.dirtyText !== undefined && parsed.record.dirtyText !== expectation.dirtyText) {
            return {kind: 'invalid', recordName, reason: 'dirty-text-mismatch'};
        }
        return {kind: 'valid', record: parsed.record};
    }

    async recoverCold(
        identityInput: DocumentProvenanceIdentity,
        exactDirtyText: string,
    ): Promise<ColdDocumentProvenanceResolution> {
        if (typeof exactDirtyText !== 'string') {
            throw new Error('exactDirtyText must be a string');
        }
        await this.flush();
        const identity = canonicalizeDocumentIdentity(identityInput);
        const identityHash = documentProvenanceIdentityHash(identity);
        const prefix = recordPrefix(identityHash);
        const names = (await this.storage.list())
            .filter(name => name.startsWith(prefix) && name.endsWith(RECORD_SUFFIX))
            .sort();
        const candidates: DocumentProvenanceRecord[] = [];

        for (const recordName of names) {
            const parsed = await this.readRecord(recordName);
            if (parsed.kind !== 'valid') {
                return {
                    kind: 'invalid',
                    recordName,
                    reason: parsed.kind === 'invalid' ? parsed.reason : 'invalid-record',
                };
            }
            if (!identitiesEqual(parsed.record.identity, identity)) {
                return {kind: 'invalid', recordName, reason: 'identity-mismatch'};
            }
            if (parsed.record.dirtyText === exactDirtyText) {
                candidates.push(parsed.record);
            }
        }

        if (candidates.length === 0) {
            return {kind: 'missing'};
        }
        if (candidates.length > 1) {
            return {kind: 'ambiguous', recordNames: candidates.map(record => record.recordName)};
        }
        return {kind: 'valid', record: candidates[0]};
    }

    async markPendingWrite(recordName: string, pendingWrite: JsonValue): Promise<DocumentProvenanceRecord> {
        if (!isJsonValue(pendingWrite)) {
            throw new Error('pendingWrite must be JSON-compatible');
        }
        return this.enqueue(async () => {
            const current = this.requireValidCurrent(recordName, await this.readRecord(recordName));
            const updated: DocumentProvenanceRecord = {
                ...current,
                updatedAt: nextTimestamp(this.now, current.updatedAt),
                pendingWrite,
            };
            await this.writeRecord(updated);
            return updated;
        });
    }

    async clearPendingWrite(recordName: string): Promise<DocumentProvenanceRecord> {
        return this.enqueue(async () => {
            const current = this.requireValidCurrent(recordName, await this.readRecord(recordName));
            const updated: DocumentProvenanceRecord = {
                ...current,
                updatedAt: nextTimestamp(this.now, current.updatedAt),
            };
            delete updated.pendingWrite;
            await this.writeRecord(updated);
            return updated;
        });
    }

    /**
     * Atomically replace one exact pending intent with its next proven base.
     * A failed storage write leaves the previous pending record intact.
     */
    async reconcilePendingWrite(
        recordName: string,
        expectedPendingWrite: JsonValue,
        input: DirtyDocumentProvenance,
    ): Promise<DocumentProvenanceRecord> {
        if (!isJsonValue(expectedPendingWrite)) {
            throw new Error('expectedPendingWrite must be JSON-compatible');
        }
        return this.enqueue(async () => {
            const current = this.requireValidCurrent(recordName, await this.readRecord(recordName));
            if (current.pendingWrite === undefined
                || JSON.stringify(current.pendingWrite) !== JSON.stringify(expectedPendingWrite)) {
                throw new Error(`Cannot reconcile provenance record ${recordName}: pending-write mismatch`);
            }

            const identity = canonicalizeDocumentIdentity(input.identity);
            const bufferIncarnationId = requireNonEmptyString(
                input.bufferIncarnationId,
                'bufferIncarnationId',
            );
            const baseVersion = requireVersion(input.baseVersion, 'baseVersion');
            if (typeof input.baseText !== 'string' || typeof input.dirtyText !== 'string') {
                throw new Error('baseText and dirtyText must be strings');
            }
            if (!identitiesEqual(current.identity, identity)
                || current.bufferIncarnationId !== bufferIncarnationId
                || this.currentRecordName(identity, bufferIncarnationId) !== recordName) {
                throw new Error(`Cannot reconcile provenance record ${recordName}: identity mismatch`);
            }

            const reconciled: DocumentProvenanceRecord = {
                schemaVersion: DOCUMENT_PROVENANCE_SCHEMA_VERSION,
                recordName,
                identity,
                identityHash: current.identityHash,
                bufferIncarnationId,
                baseVersion,
                baseText: input.baseText,
                baseHash: sha256Text(input.baseText),
                dirtyText: input.dirtyText,
                dirtyHash: sha256Text(input.dirtyText),
                updatedAt: nextTimestamp(this.now, current.updatedAt),
            };
            await this.writeRecord(reconciled);
            return reconciled;
        });
    }

    async clearRecord(recordName: string): Promise<void> {
        if (!recordName.startsWith(`${RECORD_NAMESPACE}.`) || !recordName.endsWith(RECORD_SUFFIX)) {
            throw new Error('An explicit provenance record name is required');
        }
        return this.enqueue(async () => {
            await this.storage.delete(recordName);
        });
    }

    async flush(): Promise<void> {
        while (true) {
            const observedTail = this.operationTail;
            await observedTail;
            if (observedTail === this.operationTail) {
                break;
            }
        }
    }
}
