# Stale-buffer rollback acceptance matrix

Invariant: saving or reconnecting must never remove a collaborator edit or a previously confirmed user edit. When the extension cannot prove the restored buffer's ancestry, it must send no update and keep the local buffer recoverable.

| ID | Scenario | Required observable result |
| --- | --- | --- |
| P0 | Hot exit restores a dirty stale buffer; the server contains later confirmed-user and collaborator edits; no trusted base is available | No `applyOtUpdate`; server text and version are unchanged; save fails closed; the exact local text remains dirty |
| P1 | Startup `readFile` joins the latest server snapshot before the host overlays its stale backup | The fresh read is not accepted as the backup's ancestry; result is the same as P0 |
| P1a | A single editor object is first observed clean with the latest remote text and then receives a stale hot-exit overlay | The clean observation remains quarantined; the stale overlay sends no update and remains dirty |
| P2 | Restored text exactly equals the authoritative snapshot, but provenance is unavailable | Safe no-op; no wire update; save may complete |
| M1 | A trusted base belongs to another window or to another project with the same pathname and document ID | The wrong-scope base is ignored; no update is sent; authoritative and local text remain unchanged |
| B1 | A normal edit starts from the exact joined base | One effectful update at the joined version; applying its operations to the base yields the requested text |
| C1 | Trusted-base local and collaborator edits affect disjoint ranges | Only the local delta is sent relative to current remote text; final text retains both edits |
| C2 | Trusted-base local and collaborator edits overlap | No update; remote text is unchanged; local text remains recoverable as a conflict |
| R1 | A warm document session disconnects, the server advances, and the session rejoins | The retained trusted base is used; disjoint edits merge without rollback |
| R2 | The queue acknowledgement is lost before the update is applied | One retry carries the original version and operations; one logical application and one collaborator broadcast result |
| R2a | The queue acknowledgement succeeds while application and sender confirmation are held | The save remains pending and authoritative text remains unchanged until the separately released application is confirmed |
| R3 | The update is applied but its queue acknowledgement and sender confirmation are lost | A retry carries prior public IDs in `dupIfSource`; it has no second effect and no second collaborator broadcast |
| I1 | Two windows access the same project and document while one has an outcome-unknown pending update | Bases, pending updates, acknowledgements, and public-ID chains remain window-local; an intervening edit from the other window survives recovery |
| I2 | Two projects share the same pathname and document ID | Provenance and pending updates remain project-scoped; neither project can authorize or consume the other's save |
| I3 | Encoded, decoded, or reordered project-query aliases expose two dirty buffers for one logical document | The aliases share one project connection; ambiguous effectful saves emit no update and preserve both local buffers |
| J1 | A project join returns a project `_id` different from the requested project | The session terminates before state is exposed, documents are joined, or an initial compile is requested |
| S1 | The same stale buffer is reached through manual save, autosave, or compile `saveAll` | Every route uses the same fail-closed gate; a blocked initial `saveAll` prevents compilation |
| X1 | A blocked recovery dialog remains open while the document is closed and reopened at the same URI | Neither recovery-copy nor reload acts on the replacement buffer; a valid copy uses the original buffer's bytes at dialog completion |
| U1 | A user save is confirmed under an earlier public ID, then collaborator work advances the server before restart | A restored stale buffer cannot remove either confirmed region; the save fails closed and remains recoverable |

The deterministic server oracle separates three events: queue acknowledgement, effectful application, and sender-only version confirmation. A deduplicated `dupIfSource` retry is permitted on the wire; duplicate text application or duplicate collaborator broadcast is not.

The following assumptions still require host or deployment verification:

- Rejected `FileSystemProvider.writeFile` calls keep restored buffers dirty and recoverable in each supported VS Code and Cursor version.
- Hosted Overleaf and supported self-hosted releases implement the current open-source `dupIfSource`, sender-confirmation, retention-window, and `joinDoc` ordering semantics.
- Recovery records are not automatically expired; obsolete records may require later storage housekeeping, but they never confer cross-window write authority.
- Alternative/HTTP-backed mode deliberately blocks revision-unproven whole-document saves rather than staging them as realtime OT.

The version-2 provenance schema binds canonical server, verified user, project, document, logical editor identity, extension-host session, exact buffer incarnation, base revision/content, and dirty content. Integrity or schema mismatches fail closed. Cold records are recovery evidence only: they never authorize a restarted window, and multiple exact candidates are reported as ambiguous.
