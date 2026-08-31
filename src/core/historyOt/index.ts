export * from './types';

export {
    assertHistoryOtOperationsSafe,
    assertHistoryOtSnapshotSafe,
    HISTORY_OT_MAX_STRING_LENGTH,
    HistoryOtProtocolError,
    parseHistoryOtOperations,
    parseHistoryOtSnapshot,
    serializeHistoryOtOperations,
    serializeHistoryOtSnapshot,
} from './protocol';

export {
    applyHistoryOtOperations,
    composeHistoryOtOperations,
    invertHistoryOtOperations,
    transformHistoryOtOperations,
} from './operations';

export {
    buildAcceptTrackedChangesOperation,
    buildHistoryOtTextUpdate,
    buildRejectTrackedChangesOperation,
} from './builders';

import {
    HistoryOtOffsetAffinity,
    HistoryOtSnapshotInput,
} from './types';
import {getSafeSnapshotRaw} from './protocol';
import {
    mapSnapshotOffsetToVisible,
    mapVisibleOffsetToSnapshot,
    visibleText,
} from './snapshot';

export function getVisibleHistoryOtText(snapshot: HistoryOtSnapshotInput): string {
    return visibleText(getSafeSnapshotRaw(snapshot));
}

export function snapshotOffsetToVisible(
    snapshot: HistoryOtSnapshotInput,
    offset: number,
): number {
    return mapSnapshotOffsetToVisible(getSafeSnapshotRaw(snapshot), offset);
}

/**
 * The default left affinity matches Overleaf's collapsed tracked-delete boundary.
 * Right affinity is available for callers that need the snapshot position after
 * all hidden deletions at that visible boundary.
 */
export function visibleOffsetToSnapshot(
    snapshot: HistoryOtSnapshotInput,
    offset: number,
    affinity: HistoryOtOffsetAffinity = 'left',
): number {
    return mapVisibleOffsetToSnapshot(getSafeSnapshotRaw(snapshot), offset, affinity);
}
