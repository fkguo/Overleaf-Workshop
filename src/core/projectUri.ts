export interface ProjectUriComponents {
    userId: string;
    projectId: string;
    serverName: string;
    projectName: string;
    identifier: string;
    pathParts: string[];
}

function parseProjectQuery(rawQuery: string): URLSearchParams {
    let candidate = rawQuery;
    // VS Code normally exposes a decoded Uri.query, while some Cursor history
    // restore paths can preserve an encoded whole query string. Accept both
    // representations (and one extra encoding layer) deterministically.
    for (let pass = 0; pass < 3; pass += 1) {
        const params = new URLSearchParams(candidate);
        if (params.has('user') && params.has('project')) {
            return params;
        }
        try {
            const decoded = decodeURIComponent(candidate);
            if (decoded === candidate) { break; }
            candidate = decoded;
        } catch {
            break;
        }
    }
    throw new Error('Invalid Overleaf project URI: missing user or project query parameter');
}

export function parseProjectUri(
    authority: string,
    path: string,
    rawQuery: string,
): ProjectUriComponents {
    const params = parseProjectQuery(rawQuery);
    const userId = params.get('user');
    const projectId = params.get('project');
    if (!userId || !projectId) {
        throw new Error('Invalid Overleaf project URI: empty user or project query parameter');
    }

    const pathParts = path.split('/');
    const projectName = decodeURIComponent(pathParts[1] ?? '');
    const identifier = `${userId}/${projectId}/${projectName}`;
    return {
        userId,
        projectId,
        serverName: authority,
        projectName,
        identifier,
        pathParts: pathParts.slice(2),
    };
}

export function projectConnectionKey(authority: string, rawQuery: string): string {
    const params = parseProjectQuery(rawQuery);
    const userId = params.get('user');
    const projectId = params.get('project');
    if (!userId || !projectId) {
        throw new Error('Invalid Overleaf project URI: empty user or project query parameter');
    }
    return `${authority}\0${userId}\0${projectId}`;
}
