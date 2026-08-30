export type SourcePosition = {
    line: number,
    character: number,
};

export type SynctexSourceLocation = {
    file: string,
    line: number,
    column: number,
};

export class LatestRequestGate {
    private readonly generations = new Map<string, number>();

    begin(key: string): number {
        const generation = (this.generations.get(key) ?? 0) + 1;
        this.generations.set(key, generation);
        return generation;
    }

    invalidate(key: string): void {
        this.begin(key);
    }

    isCurrent(key: string, generation: number): boolean {
        return this.generations.get(key) === generation;
    }
}

export function resolveSynctexOutputIdentity(
    outputs: Array<{path: string, url: string, build?: string, editorId?: string}>,
    editorSessionId: string,
): {buildId?: string, editorId?: string} {
    const pdfOutput = outputs.find(output => output.path === 'output.pdf');
    const buildOutput = pdfOutput ?? outputs[0];
    if (!buildOutput) { return {}; }

    const editorId = pdfOutput?.editorId || editorSessionId;
    const urlBuild = buildOutput.url.match(/\/build\/([^/]+)/)?.[1];
    const buildId = buildOutput.build ||
        (urlBuild?.startsWith(`${editorId}-`)
            ? urlBuild.slice(editorId.length + 1)
            : urlBuild);
    return {buildId, editorId};
}

function normalizeProjectPath(path: string): string {
    return path.replace(/^\/+/, '').replace(/\\/g, '/');
}

export function normalizeSynctexResultPath(path: string): string | undefined {
    const normalized = path.replace(/\\/g, '/');
    if (normalized.startsWith('/')) { return undefined; }
    const parts: string[] = [];
    for (const part of normalized.split('/')) {
        if (!part || part === '.') { continue; }
        if (part === '..') { return undefined; }
        parts.push(part);
    }
    return parts.length > 0 ? parts.join('/') : undefined;
}

/** Convert a zero-based editor position into Overleaf's SyncTeX request shape. */
export function toSynctexSourceLocation(
    filePath: string,
    position: SourcePosition,
    rootDocPath = '',
): SynctexSourceLocation {
    let file = normalizeProjectPath(filePath);
    const rootDoc = normalizeProjectPath(rootDocPath);
    const rootDocDirectory = rootDoc.split('/').slice(0, -1).join('/');

    // SyncTeX records paths relative to the root document. Overleaf inserts a
    // literal `./` after a non-root project directory for this case.
    if (rootDocDirectory && (
        file === rootDocDirectory || file.startsWith(`${rootDocDirectory}/`)
    )) {
        file = `${rootDocDirectory}/.${file.slice(rootDocDirectory.length)}`;
    }

    return {
        file,
        line: Math.max(0, position.line) + 1,
        column: Math.max(0, position.character),
    };
}
