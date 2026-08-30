export type CommandExecutor = (
    command: string,
    ...args: any[]
) => PromiseLike<unknown> | unknown;

/**
 * Open a remote project without creating its VFS in the source window. The
 * destination extension host activates on the custom filesystem scheme and
 * owns the project session for that window.
 */
export async function openProjectFolder(
    executeCommand: CommandExecutor,
    uri: unknown,
    newWindow: boolean,
): Promise<void> {
    await executeCommand('vscode.openFolder', uri, newWindow);
}
