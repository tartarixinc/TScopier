"use strict";
/** Mirror of supabase/functions/_shared/brokerConnectError.ts for worker DB writes. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMtBridgeGlitchMessage = isMtBridgeGlitchMessage;
exports.isMtBridgeGlitchError = isMtBridgeGlitchError;
exports.isSessionDropMessage = isSessionDropMessage;
exports.classifyBrokerConnectError = classifyBrokerConnectError;
exports.friendlyBrokerConnectError = friendlyBrokerConnectError;
const WRONG_PASSWORD = /invalid password|wrong password|incorrect password|bad password|authorization failed|not authorized|invalid credentials|auth(?:entication)? failed|login failed|password (?:is )?invalid|invalid account password|access denied|invalid_password|(?:^|\D)3006(?:\D|$)/i;
const WRONG_LOGIN = /invalid account|unknown account|account not found|invalid login|wrong login|user not found|login (?:is )?invalid|invalid user|no such account|account disabled|account has been disabled|account blocked|trade account disabled|invalid_account|(?:^|\D)1001(?:\D|$)/i;
const WRONG_SERVER = /server not found|unknown server|invalid server|cannot find server|no such server|server (?:is )?invalid|host not found|server does not exist|cannot connect to (?:the )?server|failed to resolve server|invalid_server|invalid_terminal|(?:^|\D)1008(?:\D|$)|(?:^|\D)1000(?:\D|$)/i;
const INVESTOR = /investor password|read[- ]?only|trade disabled|not allowed to trade|investor mode/i;
const SESSION_EXPIRED = /session expired|client with id|client not found|unknown client|session not found|broker session is not connected|not connected|trading session expired|verifytradingready failed|keepsessionalive failed|heartbeat keepsessionalive failed/i;
const CREDENTIAL_CONNECT_AMBIGUOUS = /not connected|broker session is not connected|accountsummary returned no data|could not verify broker|connect failed|authentication failed|could not authenticate/i;
const TERMINAL_NOT_READY = /could not fetch account summary|accountsummary returned no data|terminal did not reach connected|fxsocket terminal connection failed/i;
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
function classifyBrokerConnectError(raw, opts) {
    const message = String(raw ?? '').trim();
    const combined = `${message} ${opts?.errorCode ?? ''}`.trim();
    if (!message)
        return 'unknown';
    if (INVESTOR.test(combined))
        return 'investor_password';
    if (WRONG_PASSWORD.test(combined))
        return 'wrong_password';
    if (isMtBridgeGlitchMessage(message))
        return 'session_expired';
    if (WRONG_LOGIN.test(combined))
        return 'wrong_login';
    if (WRONG_SERVER.test(combined))
        return 'wrong_server';
    if (/account disabled|account has been disabled|account blocked|trade account disabled/i.test(combined)) {
        return 'account_disabled';
    }
    if (SESSION_EXPIRED.test(message)) {
        if (opts?.credentialConnect && !isMtBridgeGlitchMessage(message)) {
            return 'credentials_rejected';
        }
        return 'session_expired';
    }
    if (TERMINAL_NOT_READY.test(message)) {
        return 'terminal_not_ready';
    }
    if (opts?.credentialConnect && CREDENTIAL_CONNECT_AMBIGUOUS.test(message)) {
        return 'credentials_rejected';
    }
    return 'unknown';
}
function friendlyBrokerConnectError(raw, opts) {
    const kind = classifyBrokerConnectError(raw, opts);
    switch (kind) {
        case 'wrong_password':
            return 'The MT account password is incorrect. Check the password in your MetaTrader terminal, then try again.';
        case 'wrong_login':
            return 'The MT login number does not match this broker server. Verify the account number from MetaTrader.';
        case 'wrong_server':
            return 'The broker server name is incorrect or does not match this login. Check the exact server name from MetaTrader.';
        case 'investor_password':
            return 'An investor (read-only) password was used. Connect with the main trading password from MetaTrader.';
        case 'account_disabled':
            return 'This MT account is disabled or blocked at the broker. Contact your broker or log in via MetaTrader first.';
        case 'credentials_rejected':
            return 'Could not log in with these MT details. Verify your account number, trading password, and exact server name from MetaTrader.';
        case 'terminal_not_ready':
            return 'We could not load your account from the broker yet. If you just connected, wait a minute and try again. Otherwise verify your MT login, password, and server name match MetaTrader exactly.';
        case 'session_expired':
            if (isMtBridgeGlitchMessage(raw)) {
                return 'Broker connection dropped after a trade-server glitch. Use Reconnect — your login details are usually still correct.';
            }
            return 'Trading session expired on the trade server. Use Reconnect and enter your current MT password.';
        default:
            if (opts?.credentialConnect) {
                return 'Could not log in with these MT details. Verify your account number, trading password, and exact server name from MetaTrader.';
            }
            return String(raw ?? '').trim()
                || 'Broker connection failed. Check your MT login details or use Reconnect if this account was linked before.';
    }
}
