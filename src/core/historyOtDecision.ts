import type {HistoryOtRange} from './historyOt';
import type {
    HistoryOtTrackedChangeDescriptor,
    RealtimeHistoryOtPresentationModel,
} from '../scm/trackChangesPresentation';

export interface HistoryOtDecisionTargetIdentity {
    readonly stableId: string,
    readonly type: 'insert' | 'delete',
    readonly range: HistoryOtRange,
    readonly authorId: string,
    readonly timestamp: string,
}

function matches(
    change: HistoryOtTrackedChangeDescriptor,
    target: HistoryOtDecisionTargetIdentity,
): boolean {
    return change.stableId === target.stableId
        && (change.kind === 'tracked-insertion' ? 'insert' : 'delete') === target.type
        && change.snapshotRange.pos === target.range.pos
        && change.snapshotRange.length === target.range.length
        && change.authorId === target.authorId
        && change.timestamp === target.timestamp;
}

/**
 * Resolve immutable editor targets against one fresh authoritative presentation.
 * A target must have exactly one complete identity match; duplicate targets and
 * coordinate-only matches fail closed.
 */
export function resolveHistoryOtDecisionTargets(
    model: RealtimeHistoryOtPresentationModel,
    targets: readonly HistoryOtDecisionTargetIdentity[],
    expectedVisibleText: string,
): HistoryOtRange[] {
    if (model.visibleText !== expectedVisibleText) {
        throw new Error('The authoritative History OT text changed after the selection was resolved');
    }
    const stableIds = new Set<string>();
    return targets.map(target => {
        if (stableIds.has(target.stableId)) {
            throw new Error(`Duplicate tracked-change target ${target.stableId}`);
        }
        stableIds.add(target.stableId);
        const candidates = model.trackedChanges.filter(change => matches(change, target));
        if (candidates.length !== 1) {
            throw new Error(`Tracked-change target ${target.stableId} is no longer authoritative`);
        }
        return {
            pos: candidates[0].snapshotRange.pos,
            length: candidates[0].snapshotRange.length,
        };
    });
}
