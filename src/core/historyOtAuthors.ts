import type {ChangesUserSchema, MemberEntity} from '../api/base';
import type {HistoryOtMemberData, HistoryOtMemberDirectory} from '../scm/trackChangesPresentation';

/**
 * Match the official Review Panel precedence: historical changes users first,
 * then the current owner/members as the fresher record for duplicate ids.
 */
export function mergeHistoryOtMemberDirectory(
    changesUsers: readonly ChangesUserSchema[] | undefined,
    currentMembers: readonly (MemberEntity | undefined)[],
): HistoryOtMemberDirectory {
    const members = new Map<string, HistoryOtMemberData | null>();
    for (const user of changesUsers ?? []) {
        members.set(user.id, user);
    }
    for (const member of currentMembers) {
        if (member?._id) { members.set(member._id, member); }
    }
    return members;
}
