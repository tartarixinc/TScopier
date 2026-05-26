"use strict";
/** Mirror of supabase/functions/_shared/brokerConnectError.ts for worker DB writes. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMtBridgeGlitchMessage = isMtBridgeGlitchMessage;
exports.isMtBridgeGlitchError = isMtBridgeGlitchError;
exports.isSessionDropMessage = isSessionDropMessage;
exports.classifyBrokerConnectError = classifyBrokerConnectError;
exports.friendlyBrokerConnectError = friendlyBrokerConnectError;
const WRONG_PASSWORD = /invalid password|wrong password|incorrect password|bad password|authorization failed|not authorized|invalid credentials|auth(?:entication)? failed|login failed|password (?:is )?invalid|invalid account password/i;
const WRONG_LOGIN = /invalid account|unknown account|account not found|invalid login|wrong login|user not found|login (?:is )?invalid|invalid user|no such account|account disabled|account has been disabled|account blocked|trade account disabled/i;
const WRONG_SERVER = /server not found|unknown server|invalid server|cannot find server|no such server|server (?:is )?invalid|host not found|server does not exist|cannot connect to (?:the )?server|failed to resolve server/i;
const INVESTOR = /investor password|read[- ]?only|trade disabled|not allowed to trade|investor mode/i;
const SESSION_EXPIRED = /session expired|client with id|client not found|unknown client|session not found|broker session is not connected|not connected|trading session expired|verifytradingready failed|keepsessionalive failed|heartbeat keepsessionalive failed/i;
const BRIDGE_GLITCH = /object reference not set|nullreferenceexception|null reference|unexpected error|internal server error|an error occurred while handling|sequence contains no elements/i;
function isMtBridgeGlitchMessage(message) {
    return BRIDGE_GLITCH.test(String(message ?? '').trim());
}
function isMtBridgeGlitchError(err) {
    if (err instanceof Error)
        return isMtBridgeGlitchMessage(err.message);
    return isMtBridgeGlitchMessage(String(err));
}
function isSessionDropMessage(message) {
    const m = String(message ?? '').trim();
    if (!m)
        return false;
    if (isMtBridgeGlitchMessage(m))
        return true;
    return SESSION_EXPIRED.test(m);
}
function classifyBrokerConnectError(raw) {
    const message = String(raw ?? '').trim();
    if (!message)
        return 'unknown';
    if (INVESTOR.test(message))
        return 'investor_password';
    if (WRONG_PASSWORD.test(message))
        return 'wrong_password';
    if (isMtBridgeGlitchMessage(message))
        return 'session_expired';
    if (SESSION_EXPIRED.test(message))
        return 'session_expired';
    if (WRONG_LOGIN.test(message))
        return 'wrong_login';
    if (WRONG_SERVER.test(message))
        return 'wrong_server';
    if (/account disabled|account has been disabled|account blocked|trade account disabled/i.test(message)) {
        return 'account_disabled';
    }
    return 'unknown';
}
function friendlyBrokerConnectError(raw) {
    switch (classifyBrokerConnectError(raw)) {
        case 'wrong_password':
            return 'The MT account password is incorrect. Check the password in your MetaTrader terminal, then use Reconnect.';
        case 'wrong_login':
            return 'The MT login number does not match this linked account. Verify the account number or remove and link the account again.';
        case 'wrong_server':
            return 'The broker server name is incorrect or does not match this login. Check the exact server name from MetaTrader.';
        case 'investor_password':
            return 'An investor (read-only) password was used. Connect with the main trading password from MetaTrader.';
        case 'account_disabled':
            return 'This MT account is disabled or blocked at the broker. Contact your broker or log in via MetaTrader first.';
        case 'session_expired':
            if (isMtBridgeGlitchMessage(raw)) {
                return 'Broker connection dropped after a trade-server glitch. Use Reconnect — your login details are usually still correct.';
            }
            return 'Trading session expired on the trade server. Use Reconnect and enter your current MT password.';
        default:
            return String(raw ?? '').trim()
                || 'Broker connection dropped unexpectedly. Use Reconnect — this is usually a temporary session issue, not wrong login details.';
    }
}
