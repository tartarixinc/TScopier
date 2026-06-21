"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAdminAccessActive = isAdminAccessActive;
/** True when DB admin bypass is active (respects timed expiry). */
function isAdminAccessActive(profile) {
    if (profile?.is_admin !== true)
        return false;
    const until = profile.admin_until;
    if (until == null || until === '')
        return true;
    return new Date(until).getTime() > Date.now();
}
