# Overleaf Workshop

[![Fork release](https://img.shields.io/github/v/release/fkguo/Overleaf-Workshop)](https://github.com/fkguo/Overleaf-Workshop/releases/latest)

Open Overleaf (ShareLaTeX) projects in VS Code or a compatible VS Code-based editor, with realtime collaborative editing and integrated PDF previews.

This is a fork of [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop), with modifications last updated on 2026-09-06. Its GitHub releases are separate from upstream and the Marketplace extension; they are not endorsed by upstream or Overleaf.

### Install this fork

1. Download the `overleaf-workshop-<version>.vsix` asset from the [latest fork release](https://github.com/fkguo/Overleaf-Workshop/releases/latest).
2. In VS Code or a compatible VS Code-based editor, run **Extensions: Install from VSIX...** and select the downloaded file. This fork retains the extension ID `iamhyc.overleaf-workshop`, so it replaces that installation rather than installing a second extension.
3. Preserve any unsaved work, then run **Developer: Reload Window**.

Disable automatic updates for this extension if you want to keep using the fork: a Marketplace update can replace it with the upstream build. See [CHANGELOG.md](./CHANGELOG.md) for changes in this fork.

### Collaboration, history, and recovery

- Text is synchronized while typing; an explicit save is not required for every collaboration update. Saves and realtime updates retain checks against stale or unconfirmed document state.
- **Reload Remote** in an Overleaf TeX tab reads the remote text without saving or compiling. A local draft is compared and backed up before explicit replacement; pending or unconfirmed writes stop the reload. Replacement may leave the editor marked as unsaved until you explicitly save it. This manual action does not replace normal realtime synchronization.
- In **History**, open a version comparison and hover over a changed block to see participants and the change interval when the server supplies that information. A block's participant list is not necessarily authorship for every individual character. The History sidebar remains available while browsing comparisons.
- History OT editing and Track Changes data are supported on compatible sessions. **Accepting or rejecting tracked changes is not enabled in this fork**; use the Overleaf web editor for those actions.
- If a save is blocked, keep the local draft and use **Save Recovery Copy...** before replacing it. **Reload Remote** is offered only when the editor has a resolvable remote binding and the connection is ready; the target is checked again before replacement. An unbound restored draft can instead use **Compare with Remote** to inspect read-only snapshots, then save a local copy and explicitly confirm a reload. Reading or comparing remote text does not authorize uploading the draft.
- Ambiguous or unconfirmed writes remain blocked. The supported text-update path also rejects NUL and non-BMP characters locally, retaining the editor text for recovery. Ordinary Chinese characters in the BMP are supported.

### Compilation and PDF navigation

- **Compile Project** requests a build even when the source is unchanged. **View Compiled PDF** opens the preview beside the source.
- After compilation, automatic PDF navigation uses the visible, unchanged source associated with that build: the cursor when visible, otherwise a position in the visible source region. Double-click the PDF to jump back to the source. Navigation requires a valid PDF and its matching SyncTeX data.
- In version 0.16.1, the compiled PDF preview has two arrows along its left edge: **→** jumps to the TeX cursor's PDF position; **←** jumps to the source corresponding to the centre of the most visible PDF page area. With multiple visible source files, select the desired TeX editor first. These buttons do not save or compile; use **Compile Project** if a matching compiled output is unavailable. Double-click remains available for precise reverse navigation.
- Drag either compact arrow up or down to reposition the group along the left edge. The position is remembered for each PDF; dragging does not trigger a jump.
- Reloading a preview or restarting the extension host refreshes available compiled output and restores the source/PDF split without implicitly saving source files or starting a new compile. If no compiled output is available, run **Compile Project**.
- A failed PDF download retains the last loaded preview and offers **Retry PDF download**. Unverified output is not used for SyncTeX navigation.

### User Guide

The [upstream user guide](https://github.com/overleaf-workshop/Overleaf-Workshop/wiki) covers general usage. The fork-specific behavior and limitations are described above.

### Features

> [!NOTE]
> For SSO login or captcha enabled servers like `https://www.overleaf.com`, please use "**Login with Cookies**" method.
> For more details, please refer to [How to Login with Cookies](#how-to-login-with-cookies).

- Login Server, Open Projects and Edit Files

    <img src="https://raw.githubusercontent.com/overleaf-workshop/Overleaf-Workshop/master/docs/assets/demo01-login.gif" height=400px/>

- On-the-fly Compiling and Previewing
  > <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>B</kbd> to compile, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd> preview.

    <img src="https://raw.githubusercontent.com/overleaf-workshop/Overleaf-Workshop/master/docs/assets/demo03-synctex.gif" height=400px/>

- SyncTeX and Reverse SyncTeX
  > <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>J</kbd> to jump to PDF.
  > Double click on PDF to jump to source code

- Chat with Collaborators

    <img src="https://raw.githubusercontent.com/overleaf-workshop/Overleaf-Workshop/master/docs/assets/demo06-chat.gif" height=400px/>

- Open Project Locally, Compile/Preview with [LaTeX-Workshop](https://github.com/James-Yu/LaTeX-Workshop)

    <img src="https://raw.githubusercontent.com/overleaf-workshop/Overleaf-Workshop/master/docs/assets/demo07-local.gif" height=400px/>

### How to Login with Cookies

<img src="https://raw.githubusercontent.com/overleaf-workshop/Overleaf-Workshop/master/docs/assets/login_with_cookie.png" height=400px/>

In an already logged-in browser (Firefox for example):

1. Open "Developer Tools" (usually by pressing <kbd>F12</kbd>) and switch to the "Network" tab;

   Then, navigate to the Overleaf main page (e.g., `https://www.overleaf.com`) in the address bar.

2. Filter the listed items with `/project` and select the exact match.

3. Check the "Cookie" under "Request Headers" of the selected item and copy its value to login.
    > The format of the Cookie value would be like: `overleaf_session2=...` or `sharelatex.sid=...`

### Compatibility

The following is the upstream compatibility list for Overleaf (ShareLaTeX) Community Edition images on [Docker Hub](https://hub.docker.com/r/sharelatex/sharelatex). It is not a new certification of every fork feature on each server version; protocol-dependent features require server support.

- [x] [sharelatex/sharelatex:5.0.4](https://hub.docker.com/layers/sharelatex/sharelatex/5.0.4/images/sha256-429f6c4c02d5028172499aea347269220fb3505cbba2680f5c981057ffa59316?context=explore) (verified by [@Mingbo-Lee](https://github.com/Mingbo-Lee))

- [x] [sharelatex/sharelatex:4.2.4](https://hub.docker.com/layers/sharelatex/sharelatex/4.2.4/images/sha256-ac0fc6dbda5e82b9c979721773aa120ad3c4a63469b791b16c3711e0b937528c?context=explore)

- [x] [sharelatex/sharelatex:4.1](https://hub.docker.com/layers/sharelatex/sharelatex/4.1/images/sha256-3798913f1ada2da8b897f6b021972db7874982b23bef162019a9ac57471bcee8?context=explore) (verified by [@iamhyc](https://github.com/iamhyc))

- [x] [sharelatex/sharelatex:3.5](https://hub.docker.com/layers/sharelatex/sharelatex/3.5/images/sha256-f97fa20e45cdbc688dc051cc4b0e0f4f91ae49fd12bded047d236ca389ad80ac?context=explore) (verified by [@iamhyc](https://github.com/iamhyc))

- [ ] [sharelatex/sharelatex:3.4](https://hub.docker.com/layers/sharelatex/sharelatex/3.4/images/sha256-2a72e9b6343ed66f37ded4e6da8df81ed66e8af77e553b91bd19307f98badc7a?context=explore)

- [ ] [sharelatex/sharelatex:3.3](https://hub.docker.com/layers/sharelatex/sharelatex/3.3/images/sha256-e1ec01563d259bbf290de4eb90dce201147c0aae5a07738c8c2e538f6d39d3a8?context=explore)

- [ ] [sharelatex/sharelatex:3.2](https://hub.docker.com/layers/sharelatex/sharelatex/3.2/images/sha256-5db71af296f7c16910f8e8939e3841dad8c9ac48ea0a807ad47ca690087f44bf?context=explore)

- [ ] [sharelatex/sharelatex:3.1](https://hub.docker.com/layers/sharelatex/sharelatex/3.1/images/sha256-5b9de1e65257cea4682c1654af06408af7f9c0e2122952d6791cdda45705e84e?context=explore)

- [ ] [sharelatex/sharelatex:3.0](https://hub.docker.com/layers/sharelatex/sharelatex/3.0/images/sha256-a36e54c66ef62fdee736ce2229289aa261b44f083a9fd553cf8264500612db27?context=explore)

### Development

Please refer to the development guidance in [CONTRIBUTING.md](./CONTRIBUTING.md)

### License and source

This modified version is distributed under the [GNU Affero General Public License, version 3](./LICENSE), without warranty as described in that license. Existing copyright and license notices are retained; third-party components retain their own licenses and notices.

Each [fork release](https://github.com/fkguo/Overleaf-Workshop/releases) links the source commit corresponding to its VSIX. The repository includes the extension source, dependency manifests, patches, and build scripts; follow [CONTRIBUTING.md](./CONTRIBUTING.md) to build it. See [CHANGELOG.md](./CHANGELOG.md) for the changes from upstream.

### References

- [Overleaf Official Logos](https://www.overleaf.com/for/partners/logos)
- [Overleaf Web Route List](./docs/webapi.md)
- [James-Yu/LaTeX-Workshop](https://github.com/James-Yu/LaTeX-Workshop)
- [jlelong/vscode-latex-basics](https://github.com/jlelong/vscode-latex-basics/tags)
