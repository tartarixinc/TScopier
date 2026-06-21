"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONDITIONAL_CLOSE_PHRASES = exports.COMMON_PARTIAL_CLOSE_PHRASES = exports.SUPPORTED_PARTIAL_CLOSE_BY_LOCALE = exports.COMMON_BREAKEVEN_PHRASES = exports.SUPPORTED_BREAKEVEN_BY_LOCALE = exports.COMMON_CLOSE_ALL_PHRASES = exports.SUPPORTED_CLOSE_ALL_BY_LOCALE = void 0;
exports.textLooksLikeConditionalClose = textLooksLikeConditionalClose;
exports.textLooksLikeMultilingualFullClose = textLooksLikeMultilingualFullClose;
exports.textLooksLikeMultilingualManagement = textLooksLikeMultilingualManagement;
/**
 * Multilingual trade-management instructions (close all, partial, breakeven, SL/TP adjust).
 * Keep in sync with supabase/functions/_shared/multilingualManagementTerms.ts
 */
const multilingualSignalTerms_1 = require("./multilingualSignalTerms");
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** Full close-all phrases by locale (en, es, fr, pl, ru, sv, nl, ja + de, ar, pt, it). */
exports.SUPPORTED_CLOSE_ALL_BY_LOCALE = {
    en: [
        'close all', 'close everything', 'close all trades', 'close all positions',
        'close full', 'flatten', 'flatten all', 'exit all', 'kill zones',
    ],
    fr: [
        'fermez tout', 'fermer tout', 'tout fermer', 'fermeture totale',
        'clôture totale', 'cloture totale', 'fermez toutes', 'fermer toutes',
    ],
    es: [
        'cerrar todo', 'cierra todo', 'cierre todo', 'cerrar todas',
        'cierra todas', 'cerrar todas las', 'cierra todas las',
    ],
    pl: [
        'zamknij wszystko', 'zamknąć wszystko', 'zamknij wszystkie',
        'zamknij wszystkie pozycje',
    ],
    ru: [
        'закрой все', 'закройте все', 'закрыть все', 'закрыть всё', 'закрой всё',
    ],
    sv: ['stäng allt', 'stang allt', 'stäng alla', 'stang alla'],
    nl: ['sluit alles', 'alles sluiten', 'sluit alle'],
    ja: ['全決済', 'すべて決済', '全クローズ', '全部決済'],
    de: ['alles schließen', 'schließe alles', 'schliesse alles', 'alles schliessen'],
    ar: ['أغلق الكل', 'اغلق الكل', 'إغلاق الكل'],
    pt: ['fechar tudo', 'feche tudo', 'fechar todas'],
    it: ['chiudi tutto', 'chiudere tutto', 'chiudi tutte'],
};
exports.COMMON_CLOSE_ALL_PHRASES = Object.freeze(Array.from(new Set(Object.values(exports.SUPPORTED_CLOSE_ALL_BY_LOCALE).flat())));
const CLOSE_VERBS = [
    'close', 'exit', 'flatten',
    'fermez', 'fermer', 'fermeture', 'clôture', 'cloture',
    'cerrar', 'cierre', 'cierra',
    'zamknij', 'zamknąć', 'zamknac',
    'закрой', 'закройте', 'закрыть',
    'stäng', 'stang', 'sluit',
    'schließen', 'schliesse', 'schliessen', 'schließe',
    'fechar', 'feche', 'chiudi', 'chiudere',
    'أغلق', 'اغلق',
];
const ALL_EVERYTHING_WORDS = [
    'all', 'everything', 'every thing',
    'tout', 'toutes', 'toda', 'todas', 'todo',
    'wszystko', 'wszystkie',
    'все', 'всё',
    'alles', 'alla', 'alle', 'tutto', 'tutte',
    '全部', 'すべて',
    'الكل',
];
const CLOSE_VERB_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${CLOSE_VERBS.map(t => escapeRegExp((0, multilingualSignalTerms_1.foldAccents)(t))).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
const ALL_EVERYTHING_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${ALL_EVERYTHING_WORDS.map(t => escapeRegExp((0, multilingualSignalTerms_1.foldAccents)(t))).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
/** Breakeven / move SL to entry cues by locale. */
exports.SUPPORTED_BREAKEVEN_BY_LOCALE = {
    en: ['breakeven', 'break even', 'move stop to breakeven', 'sl to entry', 'sl to be', 'be now'],
    fr: [
        'break even', 'point mort', 'seuil de rentabilité', 'seuil de rentabilite',
        'sl à l\'entrée', 'sl a l\'entree', 'stop à l\'entrée', 'stop a l\'entree',
        'mettre à breakeven', 'mettre a breakeven', 'passer à breakeven',
    ],
    es: ['punto de equilibrio', 'break even', 'sl a la entrada', 'stop a la entrada'],
    pl: ['na zero', 'break even', 'przenieś sl na wejście', 'przenies sl na wejscie', 'sl na wejście'],
    ru: ['безубыток', 'в безубыток', 'стоп в ноль', 'sl на вход', 'стоп на вход'],
    sv: ['break even', 'flytta stop till ingång', 'sl till ingång'],
    nl: ['break even', 'stop loss naar entry', 'sl naar entry'],
    ja: ['損益分岐', '建値', 'ブレークイーブン'],
    de: ['break even', 'stop loss auf einstieg', 'sl auf einstieg'],
    ar: ['التعادل', 'وقف الخسارة عند الدخول'],
    pt: ['break even', 'ponto de equilíbrio', 'sl na entrada'],
    it: ['break even', 'punto di pareggio', 'sl all\'ingresso'],
};
exports.COMMON_BREAKEVEN_PHRASES = Object.freeze(Array.from(new Set(Object.values(exports.SUPPORTED_BREAKEVEN_BY_LOCALE).flat())));
/** Partial-close cues by locale. */
exports.SUPPORTED_PARTIAL_CLOSE_BY_LOCALE = {
    en: [
        'close half', 'take half', 'close partial', 'take partial', 'secure profits',
        'close 50%', 'take 50%', 'close 25%',
    ],
    fr: [
        'fermer la moitié', 'fermer la moitie', 'fermer moitié', 'fermer moitie',
        'prise partielle', 'fermeture partielle', 'sécuriser', 'securiser',
        'prendre 50%', 'fermer 50%',
    ],
    es: [
        'cerrar la mitad', 'cerrar mitad', 'cierre parcial', 'cerrar parcial',
        'asegurar ganancias', 'asegurar beneficios', 'tomar 50%',
    ],
    pl: [
        'zamknij połowę', 'zamknij polowe', 'zamknij częściowo', 'zamknij czesciowo',
        'częściowe zamknięcie', 'czesciowe zamkniecie',
    ],
    ru: ['закрыть половину', 'частичное закрытие', 'частично закрыть', 'зафиксировать прибыль'],
    sv: ['stäng hälften', 'stang halften', 'delvis stängning'],
    nl: ['sluit de helft', 'gedeeltelijk sluiten', 'deels sluiten'],
    ja: ['一部決済', '半分決済'],
    de: ['halb schließen', 'teilweise schließen', 'teil schließen'],
    ar: ['إغلاق جزئي', 'اغلاق جزئي'],
    pt: ['fechar metade', 'fechamento parcial'],
    it: ['chiudi metà', 'chiusura parziale'],
};
exports.COMMON_PARTIAL_CLOSE_PHRASES = Object.freeze(Array.from(new Set(Object.values(exports.SUPPORTED_PARTIAL_CLOSE_BY_LOCALE).flat())));
/** Optional/discretionary close wording; should not trigger auto-close. */
exports.CONDITIONAL_CLOSE_PHRASES = [
    'if you are happy',
    'if you are satisfied',
    'if satisfied',
    'if in profit',
    'if you want',
    'up to you',
    'your choice',
    'si vous etes satisfait',
    'si vous êtes satisfait',
    'si estas satisfecho',
    'si estás satisfecho',
    'если вы довольны',
    'если довольны',
    'если в прибыли',
];
function textLooksLikeConditionalClose(message) {
    const raw = String(message ?? '').trim();
    if (!raw)
        return false;
    for (const phrase of exports.CONDITIONAL_CLOSE_PHRASES) {
        if ((0, multilingualSignalTerms_1.messageContainsKeyword)(raw, phrase))
            return true;
    }
    const folded = (0, multilingualSignalTerms_1.foldAccents)(raw);
    return (/\b(if|si|если)\b/i.test(folded)
        && /\b(close|cerrar|fermer|fermez|закрой|закрыть|exit)\b/i.test(folded));
}
const SL_TP_ADJUST_RE = new RegExp('\\b('
    + [
        'move stop', 'move sl', 'move risk', 'adjust sl', 'adjust stop loss', 'adjust stoploss',
        'set sl', 'set stop loss', 'set stoploss', 'set risk', 'update sl', 'change sl',
        'déplacer le sl', 'deplacer le sl', 'déplacer sl', 'deplacer sl',
        'mover sl', 'mover stop', 'ajustar sl', 'ajustar stop',
        'przenieś sl', 'przenies sl', 'przenieś stop', 'przenies stop',
        'переместить sl', 'переместить стоп', 'установить sl', 'установить стоп',
        'flytta sl', 'flytta stop', 'verplaats sl', 'sl verplaatsen',
        'sl anpassen', 'stop loss anpassen',
        'slを移動', '損切り調整',
    ].map(t => escapeRegExp((0, multilingualSignalTerms_1.foldAccents)(t))).join('|')
    + ')\\b', 'iu');
/** True for intentional full-close commands in any supported language. */
function textLooksLikeMultilingualFullClose(message) {
    const raw = String(message ?? '').trim();
    if (!raw)
        return false;
    if (/\bclose\s+to\b/i.test(raw))
        return false;
    for (const phrase of exports.COMMON_CLOSE_ALL_PHRASES) {
        if ((0, multilingualSignalTerms_1.messageContainsKeyword)(raw, phrase))
            return true;
    }
    const folded = (0, multilingualSignalTerms_1.foldAccents)(raw);
    const hasCloseVerb = CLOSE_VERB_RE.test(folded);
    const hasAllWord = ALL_EVERYTHING_RE.test(folded);
    if (hasCloseVerb && hasAllWord)
        return true;
    return false;
}
/** True for breakeven, partial close, or SL/TP adjust instructions. */
function textLooksLikeMultilingualManagement(message) {
    const raw = String(message ?? '').trim();
    if (!raw)
        return false;
    if (textLooksLikeMultilingualFullClose(raw))
        return true;
    for (const phrase of [...exports.COMMON_BREAKEVEN_PHRASES, ...exports.COMMON_PARTIAL_CLOSE_PHRASES]) {
        if ((0, multilingualSignalTerms_1.messageContainsKeyword)(raw, phrase))
            return true;
    }
    if (SL_TP_ADJUST_RE.test((0, multilingualSignalTerms_1.foldAccents)(raw)))
        return true;
    if (/\b\d{1,3}\s*%\s*(?:of\s+)?(?:the\s+)?(?:position|trade|lot|profit(?:s)?|profits|ganancias|bénéfices|benefices)\b/iu.test(raw)) {
        return true;
    }
    return false;
}
