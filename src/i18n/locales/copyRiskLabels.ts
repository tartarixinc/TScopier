export interface CopyRiskTranslations {
  emptyLimit: string
  preset: string
  presets: { none: string; conservative: string; balanced: string; aggressive: string }
  sections: {
    sizing: string
    protection: string
    exposure: string
    stops: string
    filters: string
    execution: string
    provider: string
    advanced: string
    lifecycle: string
  }
  modes: {
    fixed_lot: string
    lot_multiplier: string
    balance_ratio: string
    equity_ratio: string
    percent_risk: string
    cash_risk: string
    stop_distance: string
  }
  actions: { pause: string; close: string; closeAndPause: string }
  directions: { both: string; buy: string; sell: string }
  orderTypes: { market: string; limit: string; stop: string }
  on: string
  off: string
  add: string
  remove: string
  symbol: string
  confirmRelax: string
  confirm: string
  cancel: string
  emergencyStop: string
  resumeEmergency: string
  accountLock: string
  resumeLock: string
  sizing: {
    fixedLot: string
    lotMultiplier: string
    balanceMultiplier: string
    equityMultiplier: string
    percentRisk: string
    cashRisk: string
    referencePips: string
    minLot: string
    maxLot: string
    symbolOverride: string
  }
  protection: {
    action: string
    maxDrawdown: string
    percent: string
    cash: string
    emergency: string
    recovery: string
    maxDrawdownPercent: string
    maxDrawdownCash: string
    dailyLoss: string
    dailyLossPercent: string
    dailyLossCash: string
    weeklyLoss: string
    weeklyLossPercent: string
    weeklyLossCash: string
    monthlyLoss: string
    monthlyLossPercent: string
    monthlyLossCash: string
    minEquity: string
    maxEquityLoss: string
    floatingLoss: string
    floatingLossPercent: string
    giveback: string
    profitLock: string
    dailyProfit: string
    consecutiveLosses: string
  }
  exposure: {
    maxPositions: string
    maxLots: string
    maxPositionsSymbol: string
    maxLotsSymbol: string
    maxSameDirection: string
    maxPending: string
    maxOrderVolume: string
    maxMarginPercent: string
    minFreeMargin: string
    maxMarginOrder: string
    maxStopRisk: string
    maxStopRiskSymbol: string
    maxStopRiskProvider: string
  }
  stops: {
    copySl: string
    copyTp: string
    forceSl: string
    forceTp: string
    fixedSl: string
    fixedTp: string
    slMultiplier: string
    tpMultiplier: string
    slOffset: string
    tpOffset: string
    minSl: string
    maxSl: string
    minRr: string
    maxRr: string
    neverWiden: string
    closeOnExit: string
    maxModifications: string
  }
  filters: {
    direction: string
    orderType: string
    minVolume: string
    maxVolume: string
    maxSpread: string
    maxDeviation: string
    maxPriceMove: string
    maxAge: string
    maxPositionAge: string
    requireStop: string
    minRr: string
    maxCopies: string
    minGap: string
  }
  execution: {
    maxDeviation: string
    maxLatency: string
    maxSpread: string
    rejectMargin: string
    retryLimit: string
    retryDeadline: string
    failurePause: string
    slippagePause: string
    maxSnapshotAge: string
  }
  provider: {
    allocation: string
    maxLoss: string
    maxDrawdown: string
    maxPositions: string
    maxLots: string
    maxDailyTrades: string
    riskMultiplier: string
    consecutiveLosses: string
    suspended: string
  }
  advanced: {
    autoReduce: string
    budget: string
    drawdownStep: string
    stepDrawdown: string
    stepMultiplier: string
  }
  lifecycle: {
    pauseNew: string
    disconnectAfter: string
    disconnectAction: string
    maxUtilization: string
    accountLock: string
  }
}

const en: CopyRiskTranslations = {
  emptyLimit: 'Leave a limit blank to turn it off.',
  preset: 'Preset',
  presets: { none: 'Custom', conservative: 'Conservative', balanced: 'Balanced', aggressive: 'Aggressive' },
  sections: {
    sizing: 'Lot sizing',
    protection: 'Drawdown and account protection',
    exposure: 'Exposure and portfolio limits',
    stops: 'Stop-loss and take-profit',
    filters: 'Trade entry filters',
    execution: 'Execution and copying',
    provider: 'Provider risk',
    advanced: 'Advanced',
    lifecycle: 'Copy lifecycle',
  },
  modes: {
    fixed_lot: 'Fixed lot',
    lot_multiplier: 'Lot multiplier',
    balance_ratio: 'Balance ratio',
    equity_ratio: 'Equity ratio',
    percent_risk: 'Percent risk',
    cash_risk: 'Cash risk',
    stop_distance: 'Stop distance',
  },
  actions: { pause: 'Pause only', close: 'Close copied trades', closeAndPause: 'Close and pause' },
  directions: { both: 'Buy and sell', buy: 'Buy only', sell: 'Sell only' },
  orderTypes: { market: 'Market', limit: 'Limit', stop: 'Stop' },
  on: 'On',
  off: 'Off',
  add: 'Add',
  remove: 'Remove',
  symbol: 'Symbol',
  confirmRelax: 'Raising this limit allows more risk. Confirm before it is saved.',
  confirm: 'Confirm',
  cancel: 'Cancel',
  emergencyStop: 'Emergency stop',
  resumeEmergency: 'Resume after stop',
  accountLock: 'Lock account',
  resumeLock: 'Unlock account',
  sizing: {
    fixedLot: 'Fixed lot',
    lotMultiplier: 'Lot multiplier',
    balanceMultiplier: 'Balance multiplier',
    equityMultiplier: 'Equity multiplier',
    percentRisk: 'Risk percent',
    cashRisk: 'Cash risk',
    referencePips: 'Reference stop pips',
    minLot: 'Minimum lot',
    maxLot: 'Maximum lot',
    symbolOverride: 'Per-symbol lot',
  },
  protection: {
    action: 'When a limit is hit',
    maxDrawdown: 'Maximum drawdown',
    percent: 'Percent',
    cash: 'Cash',
    emergency: 'Emergency stop',
    recovery: 'Do not increase size after a loss',
    maxDrawdownPercent: 'Max drawdown %',
    maxDrawdownCash: 'Max drawdown cash',
    dailyLoss: 'Max daily loss',
    dailyLossPercent: 'Max daily loss %',
    dailyLossCash: 'Max daily loss cash',
    weeklyLoss: 'Max weekly loss',
    weeklyLossPercent: 'Max weekly loss %',
    weeklyLossCash: 'Max weekly loss cash',
    monthlyLoss: 'Max monthly loss',
    monthlyLossPercent: 'Max monthly loss %',
    monthlyLossCash: 'Max monthly loss cash',
    minEquity: 'Minimum equity',
    maxEquityLoss: 'Max equity loss',
    floatingLoss: 'Floating loss',
    floatingLossPercent: 'Floating loss %',
    giveback: 'Floating profit giveback',
    profitLock: 'Profit target lock',
    dailyProfit: 'Daily profit target',
    consecutiveLosses: 'Max consecutive losses',
  },
  exposure: {
    maxPositions: 'Max open positions',
    maxLots: 'Max total lots',
    maxPositionsSymbol: 'Max positions per symbol',
    maxLotsSymbol: 'Max lots per symbol',
    maxSameDirection: 'Max same-direction positions',
    maxPending: 'Max pending orders',
    maxOrderVolume: 'Max order volume',
    maxMarginPercent: 'Max margin used %',
    minFreeMargin: 'Minimum free margin',
    maxMarginOrder: 'Max margin per order',
    maxStopRisk: 'Max stop risk',
    maxStopRiskSymbol: 'Max stop risk per symbol',
    maxStopRiskProvider: 'Max stop risk per provider',
  },
  stops: {
    copySl: 'Copy source stop',
    copyTp: 'Copy source target',
    forceSl: 'Force stop',
    forceTp: 'Force target',
    fixedSl: 'Fixed stop pips',
    fixedTp: 'Fixed target pips',
    slMultiplier: 'Stop multiplier',
    tpMultiplier: 'Target multiplier',
    slOffset: 'Stop offset pips',
    tpOffset: 'Target offset pips',
    minSl: 'Min stop pips',
    maxSl: 'Max stop pips',
    minRr: 'Min reward to risk',
    maxRr: 'Max reward to risk',
    neverWiden: 'Never widen stop',
    closeOnExit: 'Close when source closes',
    maxModifications: 'Max stop changes',
  },
  filters: {
    direction: 'Direction',
    orderType: 'Order types',
    minVolume: 'Min source volume',
    maxVolume: 'Max source volume',
    maxSpread: 'Max spread points',
    maxDeviation: 'Max entry deviation',
    maxPriceMove: 'Max price move',
    maxAge: 'Max signal age seconds',
    maxPositionAge: 'Max source position age',
    requireStop: 'Require a stop',
    minRr: 'Min reward to risk',
    maxCopies: 'Max copies per period',
    minGap: 'Min seconds between copies',
  },
  execution: {
    maxDeviation: 'Max execution deviation',
    maxLatency: 'Max copy latency seconds',
    maxSpread: 'Reject when spread above',
    rejectMargin: 'Reject without enough margin',
    retryLimit: 'Retry limit',
    retryDeadline: 'Retry deadline seconds',
    failurePause: 'Pause after failed executions',
    slippagePause: 'Pause after slippage breaches',
    maxSnapshotAge: 'Max data age seconds',
  },
  provider: {
    allocation: 'Allocation % of risk budget',
    maxLoss: 'Max loss',
    maxDrawdown: 'Max drawdown %',
    maxPositions: 'Max open positions',
    maxLots: 'Max lots',
    maxDailyTrades: 'Max daily trades',
    riskMultiplier: 'Risk multiplier',
    consecutiveLosses: 'Max consecutive losses',
    suspended: 'Suspend this provider',
  },
  advanced: {
    autoReduce: 'Reduce size as limits are approached',
    budget: 'Account risk budget',
    drawdownStep: 'Drawdown size steps',
    stepDrawdown: 'Drawdown %',
    stepMultiplier: 'Lot multiplier',
  },
  lifecycle: {
    pauseNew: 'Pause new copies',
    disconnectAfter: 'Disconnect action after seconds',
    disconnectAction: 'Disconnect action',
    maxUtilization: 'Max account utilization %',
    accountLock: 'Emergency account lock',
  },
}

const es: CopyRiskTranslations = {
  emptyLimit: 'Deja un límite en blanco para desactivarlo.',
  preset: 'Perfil',
  presets: { none: 'Personalizado', conservative: 'Conservador', balanced: 'Equilibrado', aggressive: 'Agresivo' },
  sections: {
    sizing: 'Tamaño de lote',
    protection: 'Drawdown y protección de la cuenta',
    exposure: 'Exposición y límites de cartera',
    stops: 'Stop-loss y take-profit',
    filters: 'Filtros de entrada',
    execution: 'Ejecución y copiado',
    provider: 'Riesgo del proveedor',
    advanced: 'Avanzado',
    lifecycle: 'Ciclo de copia',
  },
  modes: {
    fixed_lot: 'Lote fijo',
    lot_multiplier: 'Multiplicador de lote',
    balance_ratio: 'Ratio de balance',
    equity_ratio: 'Ratio de equity',
    percent_risk: 'Riesgo porcentual',
    cash_risk: 'Riesgo en dinero',
    stop_distance: 'Distancia del stop',
  },
  actions: { pause: 'Solo pausar', close: 'Cerrar copias', closeAndPause: 'Cerrar y pausar' },
  directions: { both: 'Compra y venta', buy: 'Solo compra', sell: 'Solo venta' },
  orderTypes: { market: 'Mercado', limit: 'Límite', stop: 'Stop' },
  on: 'Sí',
  off: 'No',
  add: 'Añadir',
  remove: 'Quitar',
  symbol: 'Símbolo',
  confirmRelax: 'Subir este límite permite más riesgo. Confírmalo antes de guardarlo.',
  confirm: 'Confirmar',
  cancel: 'Cancelar',
  emergencyStop: 'Parada de emergencia',
  resumeEmergency: 'Reanudar tras la parada',
  accountLock: 'Bloquear cuenta',
  resumeLock: 'Desbloquear cuenta',
  sizing: {
    fixedLot: 'Lote fijo',
    lotMultiplier: 'Multiplicador de lote',
    balanceMultiplier: 'Multiplicador de balance',
    equityMultiplier: 'Multiplicador de equity',
    percentRisk: 'Porcentaje de riesgo',
    cashRisk: 'Riesgo en dinero',
    referencePips: 'Pips de referencia del stop',
    minLot: 'Lote mínimo',
    maxLot: 'Lote máximo',
    symbolOverride: 'Lote por símbolo',
  },
  protection: {
    action: 'Cuando se alcanza un límite',
    maxDrawdown: 'Drawdown máximo',
    percent: 'Porcentaje',
    cash: 'Dinero',
    emergency: 'Parada de emergencia',
    recovery: 'No aumentar el tamaño tras una pérdida',
    maxDrawdownPercent: 'Drawdown máx. %',
    maxDrawdownCash: 'Drawdown máx. en dinero',
    dailyLoss: 'Pérdida diaria máx.',
    dailyLossPercent: 'Pérdida diaria máx. %',
    dailyLossCash: 'Pérdida diaria máx. en dinero',
    weeklyLoss: 'Pérdida semanal máx.',
    weeklyLossPercent: 'Pérdida semanal máx. %',
    weeklyLossCash: 'Pérdida semanal máx. en dinero',
    monthlyLoss: 'Pérdida mensual máx.',
    monthlyLossPercent: 'Pérdida mensual máx. %',
    monthlyLossCash: 'Pérdida mensual máx. en dinero',
    minEquity: 'Equity mínimo',
    maxEquityLoss: 'Pérdida de equity máx.',
    floatingLoss: 'Pérdida flotante',
    floatingLossPercent: 'Pérdida flotante %',
    giveback: 'Retroceso del beneficio flotante',
    profitLock: 'Bloqueo por objetivo',
    dailyProfit: 'Objetivo de beneficio diario',
    consecutiveLosses: 'Pérdidas consecutivas máx.',
  },
  exposure: {
    maxPositions: 'Posiciones abiertas máx.',
    maxLots: 'Lotes totales máx.',
    maxPositionsSymbol: 'Posiciones máx. por símbolo',
    maxLotsSymbol: 'Lotes máx. por símbolo',
    maxSameDirection: 'Posiciones máx. en la misma dirección',
    maxPending: 'Órdenes pendientes máx.',
    maxOrderVolume: 'Volumen máx. por orden',
    maxMarginPercent: 'Margen usado máx. %',
    minFreeMargin: 'Margen libre mínimo',
    maxMarginOrder: 'Margen máx. por orden',
    maxStopRisk: 'Riesgo de stop máx.',
    maxStopRiskSymbol: 'Riesgo de stop máx. por símbolo',
    maxStopRiskProvider: 'Riesgo de stop máx. por proveedor',
  },
  stops: {
    copySl: 'Copiar stop de origen',
    copyTp: 'Copiar objetivo de origen',
    forceSl: 'Forzar stop',
    forceTp: 'Forzar objetivo',
    fixedSl: 'Stop fijo en pips',
    fixedTp: 'Objetivo fijo en pips',
    slMultiplier: 'Multiplicador del stop',
    tpMultiplier: 'Multiplicador del objetivo',
    slOffset: 'Ajuste del stop en pips',
    tpOffset: 'Ajuste del objetivo en pips',
    minSl: 'Stop mínimo en pips',
    maxSl: 'Stop máximo en pips',
    minRr: 'Reward/risk mínimo',
    maxRr: 'Reward/risk máximo',
    neverWiden: 'No ampliar el stop',
    closeOnExit: 'Cerrar cuando cierra el origen',
    maxModifications: 'Cambios de stop máx.',
  },
  filters: {
    direction: 'Dirección',
    orderType: 'Tipos de orden',
    minVolume: 'Volumen de origen mín.',
    maxVolume: 'Volumen de origen máx.',
    maxSpread: 'Spread máx. en puntos',
    maxDeviation: 'Desviación de entrada máx.',
    maxPriceMove: 'Movimiento de precio máx.',
    maxAge: 'Antigüedad máx. de la señal',
    maxPositionAge: 'Antigüedad máx. de la posición',
    requireStop: 'Exigir un stop',
    minRr: 'Reward/risk mínimo',
    maxCopies: 'Copias máx. por periodo',
    minGap: 'Segundos mín. entre copias',
  },
  execution: {
    maxDeviation: 'Desviación de ejecución máx.',
    maxLatency: 'Latencia máx. en segundos',
    maxSpread: 'Rechazar si el spread supera',
    rejectMargin: 'Rechazar sin margen suficiente',
    retryLimit: 'Reintentos',
    retryDeadline: 'Plazo de reintento en segundos',
    failurePause: 'Pausar tras fallos de ejecución',
    slippagePause: 'Pausar tras excesos de slippage',
    maxSnapshotAge: 'Antigüedad máx. de los datos',
  },
  provider: {
    allocation: 'Asignación % del presupuesto',
    maxLoss: 'Pérdida máx.',
    maxDrawdown: 'Drawdown máx. %',
    maxPositions: 'Posiciones abiertas máx.',
    maxLots: 'Lotes máx.',
    maxDailyTrades: 'Operaciones diarias máx.',
    riskMultiplier: 'Multiplicador de riesgo',
    consecutiveLosses: 'Pérdidas consecutivas máx.',
    suspended: 'Suspender este proveedor',
  },
  advanced: {
    autoReduce: 'Reducir el tamaño al acercarse al límite',
    budget: 'Presupuesto de riesgo de la cuenta',
    drawdownStep: 'Escalones de drawdown',
    stepDrawdown: 'Drawdown %',
    stepMultiplier: 'Multiplicador de lote',
  },
  lifecycle: {
    pauseNew: 'Pausar copias nuevas',
    disconnectAfter: 'Acción tras segundos desconectado',
    disconnectAction: 'Acción por desconexión',
    maxUtilization: 'Utilización máx. de la cuenta %',
    accountLock: 'Bloqueo de emergencia de la cuenta',
  },
}

const fr: CopyRiskTranslations = {
  emptyLimit: 'Laissez une limite vide pour la désactiver.',
  preset: 'Profil',
  presets: { none: 'Personnalisé', conservative: 'Prudent', balanced: 'Équilibré', aggressive: 'Agressif' },
  sections: {
    sizing: 'Taille de lot',
    protection: 'Drawdown et protection du compte',
    exposure: 'Exposition et limites de portefeuille',
    stops: 'Stop-loss et take-profit',
    filters: 'Filtres d’entrée',
    execution: 'Exécution et copie',
    provider: 'Risque du fournisseur',
    advanced: 'Avancé',
    lifecycle: 'Cycle de copie',
  },
  modes: {
    fixed_lot: 'Lot fixe',
    lot_multiplier: 'Multiplicateur de lot',
    balance_ratio: 'Ratio de balance',
    equity_ratio: 'Ratio d’équité',
    percent_risk: 'Risque en pourcentage',
    cash_risk: 'Risque en argent',
    stop_distance: 'Distance du stop',
  },
  actions: { pause: 'Pause seule', close: 'Clôturer les copies', closeAndPause: 'Clôturer et mettre en pause' },
  directions: { both: 'Achat et vente', buy: 'Achat seulement', sell: 'Vente seulement' },
  orderTypes: { market: 'Marché', limit: 'Limite', stop: 'Stop' },
  on: 'Oui',
  off: 'Non',
  add: 'Ajouter',
  remove: 'Retirer',
  symbol: 'Symbole',
  confirmRelax: 'Augmenter cette limite autorise plus de risque. Confirmez avant l’enregistrement.',
  confirm: 'Confirmer',
  cancel: 'Annuler',
  emergencyStop: 'Arrêt d’urgence',
  resumeEmergency: 'Reprendre après l’arrêt',
  accountLock: 'Verrouiller le compte',
  resumeLock: 'Déverrouiller le compte',
  sizing: {
    fixedLot: 'Lot fixe',
    lotMultiplier: 'Multiplicateur de lot',
    balanceMultiplier: 'Multiplicateur de balance',
    equityMultiplier: 'Multiplicateur d’équité',
    percentRisk: 'Pourcentage de risque',
    cashRisk: 'Risque en argent',
    referencePips: 'Pips de référence du stop',
    minLot: 'Lot minimum',
    maxLot: 'Lot maximum',
    symbolOverride: 'Lot par symbole',
  },
  protection: {
    action: 'Quand une limite est atteinte',
    maxDrawdown: 'Drawdown maximum',
    percent: 'Pourcentage',
    cash: 'Argent',
    emergency: 'Arrêt d’urgence',
    recovery: 'Ne pas augmenter la taille après une perte',
    maxDrawdownPercent: 'Drawdown max %',
    maxDrawdownCash: 'Drawdown max en argent',
    dailyLoss: 'Perte journalière max',
    dailyLossPercent: 'Perte journalière max %',
    dailyLossCash: 'Perte journalière max en argent',
    weeklyLoss: 'Perte hebdomadaire max',
    weeklyLossPercent: 'Perte hebdomadaire max %',
    weeklyLossCash: 'Perte hebdomadaire max en argent',
    monthlyLoss: 'Perte mensuelle max',
    monthlyLossPercent: 'Perte mensuelle max %',
    monthlyLossCash: 'Perte mensuelle max en argent',
    minEquity: 'Équité minimum',
    maxEquityLoss: 'Perte d’équité max',
    floatingLoss: 'Perte flottante',
    floatingLossPercent: 'Perte flottante %',
    giveback: 'Repli du profit flottant',
    profitLock: 'Verrouillage d’objectif',
    dailyProfit: 'Objectif de profit du jour',
    consecutiveLosses: 'Pertes consécutives max',
  },
  exposure: {
    maxPositions: 'Positions ouvertes max',
    maxLots: 'Lots totaux max',
    maxPositionsSymbol: 'Positions max par symbole',
    maxLotsSymbol: 'Lots max par symbole',
    maxSameDirection: 'Positions max dans le même sens',
    maxPending: 'Ordres en attente max',
    maxOrderVolume: 'Volume max par ordre',
    maxMarginPercent: 'Marge utilisée max %',
    minFreeMargin: 'Marge libre minimum',
    maxMarginOrder: 'Marge max par ordre',
    maxStopRisk: 'Risque de stop max',
    maxStopRiskSymbol: 'Risque de stop max par symbole',
    maxStopRiskProvider: 'Risque de stop max par fournisseur',
  },
  stops: {
    copySl: 'Copier le stop source',
    copyTp: 'Copier l’objectif source',
    forceSl: 'Forcer le stop',
    forceTp: 'Forcer l’objectif',
    fixedSl: 'Stop fixe en pips',
    fixedTp: 'Objectif fixe en pips',
    slMultiplier: 'Multiplicateur du stop',
    tpMultiplier: 'Multiplicateur de l’objectif',
    slOffset: 'Décalage du stop en pips',
    tpOffset: 'Décalage de l’objectif en pips',
    minSl: 'Stop min en pips',
    maxSl: 'Stop max en pips',
    minRr: 'Reward/risk min',
    maxRr: 'Reward/risk max',
    neverWiden: 'Ne jamais élargir le stop',
    closeOnExit: 'Clôturer quand la source clôture',
    maxModifications: 'Modifications de stop max',
  },
  filters: {
    direction: 'Direction',
    orderType: 'Types d’ordre',
    minVolume: 'Volume source min',
    maxVolume: 'Volume source max',
    maxSpread: 'Spread max en points',
    maxDeviation: 'Écart d’entrée max',
    maxPriceMove: 'Mouvement de prix max',
    maxAge: 'Âge max du signal en secondes',
    maxPositionAge: 'Âge max de la position source',
    requireStop: 'Exiger un stop',
    minRr: 'Reward/risk min',
    maxCopies: 'Copies max par période',
    minGap: 'Secondes min entre les copies',
  },
  execution: {
    maxDeviation: 'Écart d’exécution max',
    maxLatency: 'Latence max en secondes',
    maxSpread: 'Rejeter si le spread dépasse',
    rejectMargin: 'Rejeter sans marge suffisante',
    retryLimit: 'Nombre de tentatives',
    retryDeadline: 'Délai de tentative en secondes',
    failurePause: 'Pause après échecs d’exécution',
    slippagePause: 'Pause après dépassements de slippage',
    maxSnapshotAge: 'Âge max des données en secondes',
  },
  provider: {
    allocation: 'Allocation % du budget de risque',
    maxLoss: 'Perte max',
    maxDrawdown: 'Drawdown max %',
    maxPositions: 'Positions ouvertes max',
    maxLots: 'Lots max',
    maxDailyTrades: 'Trades du jour max',
    riskMultiplier: 'Multiplicateur de risque',
    consecutiveLosses: 'Pertes consécutives max',
    suspended: 'Suspendre ce fournisseur',
  },
  advanced: {
    autoReduce: 'Réduire la taille à l’approche d’une limite',
    budget: 'Budget de risque du compte',
    drawdownStep: 'Paliers de drawdown',
    stepDrawdown: 'Drawdown %',
    stepMultiplier: 'Multiplicateur de lot',
  },
  lifecycle: {
    pauseNew: 'Suspendre les nouvelles copies',
    disconnectAfter: 'Action après secondes de déconnexion',
    disconnectAction: 'Action de déconnexion',
    maxUtilization: 'Utilisation max du compte %',
    accountLock: 'Verrouillage d’urgence du compte',
  },
}

export const copyRiskEn = en
export const copyRiskEs = es
export const copyRiskFr = fr
