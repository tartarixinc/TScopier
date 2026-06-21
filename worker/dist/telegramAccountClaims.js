"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TELEGRAM_ALREADY_LINKED = void 0;
exports.normalizeTelegramPhoneNumber = normalizeTelegramPhoneNumber;
exports.assertTelegramAccountAvailable = assertTelegramAccountAvailable;
exports.upsertTelegramAccountClaim = upsertTelegramAccountClaim;
/** Stable token returned to clients; UI maps to localized copy. */
exports.TELEGRAM_ALREADY_LINKED = 'TELEGRAM_ALREADY_LINKED';
function normalizeTelegramPhoneNumber(raw) {
    const compact = String(raw ?? '')
        .trim()
        .replace(/[\s\-()]/g, '');
    if (compact.startsWith('00'))
        return `+${compact.slice(2)}`;
    return compact;
}
async function assertTelegramAccountAvailable(supabase, userId, opts) {
    const phone = opts.phone ? normalizeTelegramPhoneNumber(opts.phone) : '';
    const telegramUserId = opts.telegramUserId == null || opts.telegramUserId === ''
        ? null
        : String(opts.telegramUserId);
    if (phone) {
        const { data, error } = await supabase
            .from('telegram_account_claims')
            .select('user_id')
            .eq('phone_number_normalized', phone)
            .maybeSingle();
        if (error)
            throw new Error(error.message);
        if (data?.user_id && data.user_id !== userId) {
            throw new Error(exports.TELEGRAM_ALREADY_LINKED);
        }
    }
    if (telegramUserId) {
        const { data, error } = await supabase
            .from('telegram_account_claims')
            .select('user_id')
            .eq('telegram_user_id', telegramUserId)
            .maybeSingle();
        if (error)
            throw new Error(error.message);
        if (data?.user_id && data.user_id !== userId) {
            throw new Error(exports.TELEGRAM_ALREADY_LINKED);
        }
    }
}
async function upsertTelegramAccountClaim(supabase, userId, opts) {
    const phone = normalizeTelegramPhoneNumber(opts.phone);
    const telegramUserId = String(opts.telegramUserId);
    const { error } = await supabase.from('telegram_account_claims').upsert({
        user_id: userId,
        telegram_user_id: telegramUserId,
        phone_number_normalized: phone,
        linked_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (error)
        throw new Error(error.message);
}
