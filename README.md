# Overleaf Workshop

[![Fork release](https://img.shields.io/github/v/release/fkguo/Overleaf-Workshop)](https://github.com/fkguo/Overleaf-Workshop/releases/latest)

Open Overleaf (ShareLaTeX) projects in VS Code or a compatible VS Code-based editor, with realtime collaborative editing and integrated PDF previews.

This is a fork of [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop). Releases from this repository are separate from the upstream Marketplace extension and are not endorsed by upstream or Overleaf.

## Features

- Open and manage Overleaf projects without leaving your editor.
- Collaborate in realtime: share text changes while typing, see collaborators' cursors, and chat.
- Compile on save or on demand, with a PDF preview beside your TeX source.
- Navigate between source and PDF using shortcuts, arrow buttons, or a double-click.
- Browse project history, compare versions, add labels, and inspect contributor information.
- Work with a [local project copy](./docs/wiki.md#local-replica-source-control) and use [LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop) for local compilation.

## Installation

1. Download the `overleaf-workshop-<version>.vsix` asset from the [latest release](https://github.com/fkguo/Overleaf-Workshop/releases/latest).
2. In VS Code or a compatible VS Code-based editor, run **Extensions: Install from VSIX...** and select the downloaded file.
3. Preserve any unsaved work, then run **Developer: Reload Window**.

This fork uses the same extension ID as the upstream extension, so installing it replaces that installation. Disable automatic updates for this extension to prevent a Marketplace update from replacing it with the upstream build.

## Connect to a project

1. Open **Overleaf Workshop** in the Activity Bar, then add your Overleaf server in **Hosts** if it is not already listed.
2. Choose **Login to Server**. For `www.overleaf.com`, use **Login with Cookies**; this also supports servers that require SSO or a captcha.
3. Select your project and choose **Open Project in Current Window** or **Open Project in New Window**. Open its TeX files from Explorer.

<img src="./docs/assets/demo01-login.gif" alt="Logging in and opening an Overleaf project" height="400"/>

### How to Login with Cookies

1. Log in to your Overleaf server in a browser.
2. Open the browser's developer tools and select **Network**, then load the server's project list (for example, `https://www.overleaf.com/project`).
3. Filter requests by `/project`, select the project-list request, and copy the **Cookie** value from its request headers.
4. Return to the extension, choose **Login with Cookies**, and paste that value.

<img src="./docs/assets/login_with_cookie.png" alt="Finding the Cookie request header in browser developer tools" height="400"/>

Keep login cookies private: they grant access to your session.

## Everyday use

### Editing and collaboration

In a connected remote project, text changes are shared while you type; you do not need to save after every edit to send them to collaborators. Other collaborators' edits appear in your editor automatically.

Use the chat view to discuss changes with collaborators. Saving and compiling are separate from live text synchronization.

### Compilation and PDF navigation

- Select a TeX tab and run **Compile Project** from its title bar or the Command Palette. It saves pending editor changes before compiling and can recompile even when nothing has changed.
- Saving a `.tex` or `.bib` file normally triggers compilation in a remote project. Turn off `overleaf-workshop.compileOnSave.enabled` in Settings if you prefer manual compilation.
- Run **View Compiled PDF** to open the preview beside the source. On project open or preview restore, the extension first looks for an existing PDF for the selected main file. If none is available and the project has no unsaved drafts, it can compile automatically. It does not save drafts just to open a preview.
- With the preview open, selecting another independent main file containing `\documentclass` switches the PDF target. Opening a chapter file keeps the selected main file. If no main file has been selected this way, the project's configured main file is used.
- After a successful compilation, the PDF follows the visible source location when the source still matches that build. Use **Jump to PDF** to navigate from the TeX cursor, or double-click a location in the PDF to return to the source.
- Along the PDF's left edge, **→** jumps from the selected TeX cursor to the PDF; **←** jumps to the source corresponding to the centre of the most visible PDF page area. Select the desired TeX tab first if several source editors are visible. Drag either arrow vertically to reposition the buttons.
- If navigation is unavailable, compile the current source again. If downloading the PDF fails, the last loaded preview is retained; use **Retry PDF download** after checking the connection.

| Action | Windows / Linux | macOS |
| --- | --- | --- |
| Compile Project | Ctrl+Alt+B | Cmd+Option+B |
| View Compiled PDF | Ctrl+Alt+V | Cmd+Option+V |
| Jump to PDF | Ctrl+Alt+J | Cmd+Option+J |

These shortcuts apply while a supported `.tex` editor has keyboard focus.

<img src="./docs/assets/demo03-synctex.gif" alt="Compiling and navigating between TeX and PDF" height="400"/>

### History

Open a source file and select a version in **History** to compare it with the previous version. Right-click a version for other comparisons or to add and remove labels.

Hover over an added or removed block in the comparison to see its participants and time interval when Overleaf provides them. This identifies participants in the block's changes, not necessarily the author of every character. The History sidebar stays available so you can select another version.

### Reloading remote text and recovering a draft

Normal collaboration updates arrive automatically. Use **Reload Remote** in a TeX tab only when you want to reload the online text manually; it does not save or compile the document.

If a save is blocked, keep the editor open and choose **Save Recovery Copy...** before replacing any text. Use **Compare with Remote** or **Reload Remote**, when offered, to review the online version. Replacing a local draft requires a recovery copy and your confirmation. Cancel if you are unsure which changes to keep.

After a reload, the editor may still show an unsaved indicator. If recovery cannot proceed, keep your local copy and resolve the connection or reported problem before trying again.

## Compatibility

- Requires VS Code 1.86 or later, or a compatible VS Code-based editor supporting that extension API.
- Self-hosted Overleaf/ShareLaTeX support varies by server version. See the [self-hosted compatibility reference](./docs/compatibility.md) for the upstream version list; history and collaboration features also depend on server support and project permissions.
- **Accepting or rejecting tracked changes is not available in the extension**; use the Overleaf web editor for those actions.
- Most everyday Chinese characters are supported. Inserting characters outside Unicode's Basic Multilingual Plane, such as many emoji and some rare characters, or a NUL character is not supported. If a write is blocked, keep a recovery copy.

## Documentation

- [Detailed user guide](./docs/README.md)
- [Changes in this fork](./CHANGELOG.md)
- [Development and build instructions](./CONTRIBUTING.md)
- [Report a problem](https://github.com/fkguo/Overleaf-Workshop/issues)

## License and source

Distributed under the [GNU Affero General Public License, version 3](./LICENSE), without warranty. Existing copyright and license notices are retained; third-party components retain their own licenses and notices.

Each [release](https://github.com/fkguo/Overleaf-Workshop/releases) links the source commit corresponding to its VSIX.
