export type FriendHelpVisitStatus =
    | 'helped'
    | 'skipped_exp_limit'
    | 'protect_dog_bypass'
    | 'no_action'
    | 'enter_failed';

export interface FriendHelpVisitResult {
    status: FriendHelpVisitStatus;
    acted: boolean;
    entered: boolean;
}

export interface FriendHelpOutcomeLog {
    event: string;
    message: string;
    result: 'ok' | 'skipped' | 'error';
    reason?: 'exp_limit' | 'no_action' | 'enter_failed';
}

export function buildFriendHelpOutcomeLog(
    outcome: FriendHelpVisitResult,
    index: number,
    total: number,
    friendName: string,
): FriendHelpOutcomeLog {
    const prefix = `批量帮助第 ${index}/${total} 个好友`;
    if (outcome.status === 'helped') {
        return { event: '批量帮助完成', message: `${prefix}完成: ${friendName}`, result: 'ok' };
    }
    if (outcome.status === 'protect_dog_bypass') {
        return { event: '批量帮助护主犬', message: `${prefix}护主犬绕过经验上限后完成: ${friendName}`, result: 'ok' };
    }
    if (outcome.status === 'skipped_exp_limit') {
        return { event: '批量帮助跳过', message: `${prefix}跳过: ${friendName}（帮助经验已达上限）`, result: 'skipped', reason: 'exp_limit' };
    }
    if (outcome.status === 'enter_failed') {
        return { event: '批量帮助失败', message: `${prefix}失败: ${friendName}（无法进入农场）`, result: 'error', reason: 'enter_failed' };
    }
    return { event: '批量帮助跳过', message: `${prefix}无需操作: ${friendName}`, result: 'skipped', reason: 'no_action' };
}
