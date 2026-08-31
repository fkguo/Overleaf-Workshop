export type CompileRequestKind = 'manual' | 'automatic';

export type CompileTrigger =
    | 'command'
    | 'initial-project'
    | 'save'
    | 'project-setting-event';

export type CompileStatus =
    | 'success'
    | 'failure'
    | 'error'
    | 'stopped-on-first-error'
    | 'clsi-maintenance'
    | 'clsi-unavailable'
    | 'compile-in-progress'
    | 'conflict'
    | 'exited'
    | 'missing-updates'
    | 'project-too-large'
    | 'rate-limited'
    | 'terminated'
    | 'too-recently-compiled'
    | 'timedout'
    | 'autocompile-backoff'
    | 'autocompile-disabled'
    | 'unavailable'
    | 'validation-problems'
    | 'validation-fail'
    | 'validation-pass';

export interface CompileOutcome {
    status: CompileStatus;
    successful: boolean;
    outputsUpdated: boolean;
    hasLog: boolean;
    message?: string;
    validationProblems?: unknown;
}

export interface CompileOutputLike {
    path: string;
}

export interface CachedCompileOutputLike extends CompileOutputLike {
    build?: string;
    editorId?: string;
}

export interface CachedCompileOptions {
    rootResourcePath?: string | null;
    draft?: boolean;
    stopOnFirstError?: boolean;
}

export interface CompileOutputRouting {
    compileGroup?: string;
    clsiServerId?: string;
    pdfDownloadDomain?: string;
}

export interface CompileDocumentState {
    projectKey?: string;
    isDirty: boolean;
}

const KNOWN_STATUSES = new Set<CompileStatus>([
    'success',
    'failure',
    'error',
    'stopped-on-first-error',
    'clsi-maintenance',
    'clsi-unavailable',
    'compile-in-progress',
    'conflict',
    'exited',
    'missing-updates',
    'project-too-large',
    'rate-limited',
    'terminated',
    'too-recently-compiled',
    'timedout',
    'autocompile-backoff',
    'autocompile-disabled',
    'unavailable',
    'validation-problems',
    'validation-fail',
    'validation-pass',
]);

/** Keep the caller's intent explicit when deciding whether to use Overleaf's auto-compile limits. */
export function compileRequestKindForTrigger(trigger: CompileTrigger): CompileRequestKind {
    return trigger === 'command' ? 'manual' : 'automatic';
}

export function mergeCompileRequestKinds(
    current: CompileRequestKind | undefined,
    incoming: CompileRequestKind,
): CompileRequestKind {
    return current === 'manual' || incoming === 'manual' ? 'manual' : 'automatic';
}

/** A cached PDF cannot represent a dirty editor which has not reached the VFS. */
export function hasDirtyCompileSource(
    projectKey: string,
    documents: readonly CompileDocumentState[],
): boolean {
    return documents.some(document => document.isDirty && document.projectKey === projectKey);
}

/**
 * Normalize both regular JSON compile responses and HTTP-level failures from
 * rate limiting/proxy maintenance into one user-facing status vocabulary.
 */
export function normalizeCompileStatus(rawStatus?: string, message?: string): CompileStatus {
    if (rawStatus && KNOWN_STATUSES.has(rawStatus as CompileStatus)) {
        return rawStatus as CompileStatus;
    }

    const httpStatus = message?.match(/^\s*(\d{3})(?::|\s)/)?.[1];
    switch (httpStatus) {
        case '413': return 'project-too-large';
        case '423': return 'compile-in-progress';
        case '429': return 'rate-limited';
        case '502':
        case '503': return 'unavailable';
        case '504': return 'timedout';
        default: return rawStatus === 'success' ? 'success' : 'error';
    }
}

/**
 * Commit all artifacts from a successful build. For any other status, commit
 * only that attempt's non-PDF artifacts and retain the last successful PDF.
 * This keeps current diagnostics/logs without making a failed build the active
 * preview or SyncTeX source.
 */
export function mergeCompileOutputs<T extends CompileOutputLike>(
    currentOutputs: readonly T[],
    incomingOutputs: readonly T[],
    successful: boolean,
): T[] {
    if (successful) {
        return [...incomingOutputs];
    }

    const previousPdf = currentOutputs.find(output => output.path === 'output.pdf');
    const currentAttemptOutputs = incomingOutputs.filter(output => output.path !== 'output.pdf');
    return previousPdf ? [...currentAttemptOutputs, previousPdf] : [...currentAttemptOutputs];
}

/** An explicitly captured empty route must not inherit another build's CDN node. */
export function resolveCompileOutputRouting(
    captured: CompileOutputRouting | undefined,
    fallback: CompileOutputRouting,
): CompileOutputRouting {
    return captured ?? fallback;
}

/** Match Overleaf's initial-cache adoption rules without weakening PDF identity checks. */
export function isCachedCompileCompatible(
    status: string | undefined,
    outputs: readonly CompileOutputLike[] | undefined,
    cached: CachedCompileOptions | undefined,
    requested: Required<CachedCompileOptions>,
): boolean {
    if (status !== 'success' || !outputs?.some(output => output.path === 'output.pdf') || !cached) {
        return false;
    }

    const cachedRoot = cached.rootResourcePath ?? null;
    const requestedRoot = requested.rootResourcePath ?? null;
    if (cachedRoot !== requestedRoot || Boolean(cached.draft) !== requested.draft) {
        return false;
    }

    // A successful stop-on-first-error build is also valid when the current
    // preference is to keep compiling. The inverse is not safe to assume.
    return !requested.stopOnFirstError || Boolean(cached.stopOnFirstError);
}

/** Cached SyncTeX must reuse the session/build pair which produced the PDF. */
export function hasUsableCachedPdfIdentity(
    outputs: readonly CachedCompileOutputLike[] | undefined,
): boolean {
    const pdf = outputs?.find(output => output.path === 'output.pdf');
    return Boolean(pdf?.build && pdf.editorId);
}
