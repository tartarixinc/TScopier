"use strict";
/**
 * Map AI training output into channel_keywords management fields.
 * Keep in sync with supabase/functions/_shared/trainingManagementKeywords.ts
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.emptyManagementGroups = emptyManagementGroups;
exports.normalizeManagementGroups = normalizeManagementGroups;
exports.flattenManagementGroups = flattenManagementGroups;
exports.hasTrainedManagementGroups = hasTrainedManagementGroups;
exports.bucketFlatManagementCues = bucketFlatManagementCues;
exports.resolveManagementGroups = resolveManagementGroups;
exports.joinKeywordPipe = joinKeywordPipe;
exports.mergeKeywordField = mergeKeywordField;
exports.applyManagementGroupsToChannelKeywords = applyManagementGroupsToChannelKeywords;
function emptyManagementGroups() {
    return {
        close_all: [],
        close_partial: [],
        close_half: [],
        break_even: [],
        modify_sl: [],
        modify_tp: [],
        close_worse_entries: [],
    };
}
function cleanTokens(raw) {
    if (!Array.isArray(raw))
        return [];
    return Array.from(new Set(raw.map((v) => String(v ?? '').trim()).filter(Boolean)));
}
function normalizeManagementGroups(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
        close_all: cleanTokens(src.close_all),
        close_partial: cleanTokens(src.close_partial),
        close_half: cleanTokens(src.close_half),
        break_even: cleanTokens(src.break_even),
        modify_sl: cleanTokens(src.modify_sl),
        modify_tp: cleanTokens(src.modify_tp),
        close_worse_entries: cleanTokens(src.close_worse_entries),
    };
}
function flattenManagementGroups(groups) {
    return Array.from(new Set(Object.values(groups).flat()));
}
function hasTrainedManagementGroups(groups) {
    return flattenManagementGroups(groups).length > 0;
}
function fold(s) {
    return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}
function looksConditionalCloseCue(raw) {
    const f = fold(raw);
    if (!/\b(close|cerrar|fermer|fermez|zamknij|закрой|закрыть|stang|stäng|sluit|exit)\b/.test(f))
        return false;
    if (/\b(close|cerrar|fermer|fermez)\s+(all|everything|todo|tout|все|всё)\b/.test(f))
        return false;
    return (/\b(if|si|если)\b/.test(f)
        || /\b(if you want|up to you|your choice|if preferred|if needed)\b/.test(f)
        || /\b(if you are happy|if you are satisfied|if satisfied)\b/.test(f));
}
/** Best-effort bucket when only a flat management_cues list exists (legacy training). */
function bucketFlatManagementCues(cues) {
    const groups = emptyManagementGroups();
    for (const raw of cues) {
        const cue = String(raw ?? '').trim();
        if (!cue)
            continue;
        if (looksConditionalCloseCue(cue))
            continue;
        const f = fold(cue);
        if (/\b(close\s+all|close\s+everything|flatten|exit\s+all)\b/.test(f)
            || (/\b(fermez|fermer)\b/.test(f) && /\btout\b/.test(f))
            || (/\bcerrar\b/.test(f) && /\btodo/.test(f))
            || (/\bzamknij\b/.test(f) && /\bwszyst/.test(f))
            || (/\b(закрой|закрыть)\b/.test(f) && /\b(все|всё)\b/.test(f))
            || (/\b(stang|stäng|sluit)\b/.test(f) && /\b(allt|alles|alle)\b/.test(f))
            || (/\b(fechar|chiudi)\b/.test(f) && /\b(tudo|tutto|tutte)\b/.test(f))
            || /\b全決済\b/.test(cue)) {
            groups.close_all.push(cue);
        }
        else if (/\b(close\s+half|50%|half)\b/.test(f)
            || /\bmoiti/.test(f)
            || /\bmitad\b/.test(f)
            || /\bpołow/.test(f)
            || /\bполовин/.test(f)) {
            groups.close_half.push(cue);
        }
        else if (/\bpartial\b/.test(f)
            || /\bpartiel/.test(f)
            || /\bparcial\b/.test(f)
            || /\bczęściow/.test(f)
            || /\bчастичн/.test(f)
            || (/\bsecure\b/.test(f) && /\bprofit/.test(f))
            || /\bsécuriser\b/.test(f) || /\bsecuriser\b/.test(f)) {
            groups.close_partial.push(cue);
        }
        else if (/\b(breakeven|break even|point mort|equilibrio|bezubytok|безубыток)\b/.test(f)
            || (/\bsl\b/.test(f) && /\b(entry|entree|entrée|ingang|wejście|вход)\b/.test(f))) {
            groups.break_even.push(cue);
        }
        else if (/\b(close\s+worse|cwe)\b/.test(f)
            || (/\b(pire|worse|peor)\b/.test(f) && /\b(entr|entry|ingang)\b/.test(f))) {
            groups.close_worse_entries.push(cue);
        }
        else if (/\b(adjust|move|set|update|change|déplacer|deplacer|mover|ajustar|przenieś|przenies|переместить|установить)\b/.test(f)
            && /\b(sl|stop|risk|стоп)\b/.test(f)) {
            groups.modify_sl.push(cue);
        }
        else if (/\b(adjust|move|set|update|change|mover|ajustar)\b/.test(f)
            && /\b(tp|take profit|target|objetivo|objectif)\b/.test(f)) {
            groups.modify_tp.push(cue);
        }
        else if (/\b(close|cerrar|fermer|fermez|zamknij|закрыть|stäng|stang|sluit)\b/.test(f)) {
            groups.close_all.push(cue);
        }
        else {
            groups.modify_sl.push(cue);
        }
    }
    return groups;
}
function resolveManagementGroups(args) {
    const explicit = normalizeManagementGroups(args.management_keyword_groups);
    if (hasTrainedManagementGroups(explicit))
        return explicit;
    const flat = cleanTokens(args.management_cues);
    if (flat.length)
        return bucketFlatManagementCues(flat);
    return emptyManagementGroups();
}
function joinKeywordPipe(tokens) {
    return Array.from(new Set(tokens.map((t) => t.trim()).filter(Boolean))).join('|');
}
function mergeKeywordField(existing, trained) {
    const base = String(existing ?? '').split('|').map((s) => s.trim()).filter(Boolean);
    if (!trained.length)
        return joinKeywordPipe(base);
    return joinKeywordPipe([...base, ...trained]);
}
function applyManagementGroupsToChannelKeywords(current, groups, opts) {
    const replace = opts?.replace ?? false;
    const update = current.update ?? {};
    const additional = current.additional ?? {};
    const merge = (existing, trained) => {
        if (!trained.length)
            return String(existing ?? '');
        if (replace)
            return joinKeywordPipe(trained);
        return mergeKeywordField(String(existing ?? ''), trained);
    };
    const closeAll = merge(additional.close_all, groups.close_all);
    const closeFull = merge(update.close_full, groups.close_all);
    return {
        update: {
            ...update,
            close_full: closeFull || String(update.close_full ?? ''),
            close_half: merge(update.close_half, groups.close_half),
            close_partial: merge(update.close_partial, groups.close_partial),
            break_even: merge(update.break_even, groups.break_even),
            adjust_sl: merge(update.adjust_sl, groups.modify_sl),
            set_sl: merge(update.set_sl, groups.modify_sl),
            adjust_tp: merge(update.adjust_tp, groups.modify_tp),
            set_tp: merge(update.set_tp, groups.modify_tp),
            close_worse_entries: merge(update.close_worse_entries, groups.close_worse_entries),
        },
        additional: {
            ...additional,
            close_all: closeAll || String(additional.close_all ?? ''),
        },
    };
}
