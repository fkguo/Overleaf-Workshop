const documentClassRegex = /\\documentclass(?:\[[^\[\]\{\}]*\])?\{([^\[\]\{\}]+)\}/;

export type CompileResource = {
    fileType?: string,
    fileId?: string,
};

export async function resolveCompileRootDocId(
    resourcePath: string,
    resolve: () => Promise<CompileResource>,
    read: () => Promise<Uint8Array>,
    onFallback?: (error: unknown) => void,
): Promise<string | undefined> {
    // The workspace folder and restored PDF/output editors are valid project
    // contexts, but they are not candidate main TeX documents. In those cases
    // the compile request must use the main document configured on Overleaf.
    if (!/\.(?:tex|ltx|ctx)$/i.test(resourcePath)) {
        return undefined;
    }

    try {
        const {fileType, fileId} = await resolve();
        if ((fileType !== 'doc' && fileType !== 'file') || !fileId) {
            return undefined;
        }
        const content = new TextDecoder().decode(await read());
        return documentClassRegex.test(content) ? fileId : undefined;
    } catch (error) {
        // A restored editor can refer to a stale resource. That must not block
        // compilation of the project's configured main document.
        onFallback?.(error);
        return undefined;
    }
}
