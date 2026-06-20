import type { RiskDisclaimerPageTranslations } from './types'

export const riskDisclaimerFr: RiskDisclaimerPageTranslations = {
  title: 'Avertissement sur les risques',
  intro:
    'Le trading de devises, CFD et autres produits à effet de levier comporte un risque important de perte. TScopier est un outil de copie de trades — pas un courtier, conseiller en investissement ni planificateur financier. Rien sur cette page ne constitue un conseil financier. Vous êtes seul responsable de vos décisions de trading et de toute perte.',
  sections: [
    {
      title: 'Risque général du trading',
      paragraphs: [
        'Vous pouvez perdre une partie ou la totalité de votre capital déposé. L’effet de levier amplifie gains et pertes. Les performances passées d’un fournisseur de signaux, d’un backtest ou de votre propre historique ne garantissent pas les résultats futurs.',
        'Les marchés peuvent gapper, s’arrêter ou bouger violemment lors des annonces. TScopier ne garantit pas que les signaux seront reçus, interprétés ou exécutés à un prix ou moment donné.',
      ],
    },
    {
      title: 'Risque lié au fournisseur de signaux',
      paragraphs: [
        'Ne copiez que des fournisseurs en qui vous avez confiance et que vous comprenez. Les fournisseurs peuvent avoir des intérêts divergents des vôtres. Captures marketing, taux de réussite et résultats triés peuvent ne pas refléter votre expérience selon compte, lot, courtier ou latence.',
        'Vérifiez les performances de manière indépendante lorsque c’est possible. Un fournisseur qui convient à d’autres peut rester inadapté à votre tolérance au risque, taille de compte ou horaires.',
      ],
    },
    {
      title: 'Repainting et tromperie sur les canaux',
      paragraphs: [
        'Certains canaux Telegram modifient ou suppriment des messages après un trade perdant pour que l’historique public paraisse parfait. Un appel « réussi » peut avoir été révisé ; un perdant peut disparaître entièrement.',
        'Ne vous fiez pas uniquement à l’historique visible du canal ni aux captures tierces. Comparez avec vos Copier Logs, relevés courtier et horodatages. Le repainting permet aux fournisseurs de paraître plus précis qu’ils ne le sont.',
      ],
    },
    {
      title: 'Limites d’interprétation et d’exécution',
      paragraphs: [
        'Les signaux sont interprétés automatiquement à partir du texte. Fautes de frappe sur stop loss (SL) ou take profit (TP) — mauvais chiffres, décimales manquantes, symboles ambigus ou unités mélangées — peuvent produire des prix invalides. TScopier peut ignorer le signal, rejeter des niveaux invalides ou appliquer vos paramètres par défaut au lieu de l’intention du fournisseur.',
        'L’exécution peut différer de l’entrée du fournisseur : slippage, requotes, exécutions partielles, distances minimales et déconnexions de session courtier influencent les résultats. Entrée stricte, pendings de range et styles multi-jambes ajoutent de la complexité. Vérifiez toujours les positions ouvertes chez votre courtier.',
      ],
    },
    {
      title: 'Risques opérationnels et de configuration',
      paragraphs: [
        'Blackouts news, filtres de canal, objectifs de profit, perte maximale, abonnement et réglages par canal peuvent bloquer ou modifier la copie. Taille de lot, mapping de symboles ou canaux non liés mal configurés expliquent souvent pourquoi les trades ne se copient pas comme prévu.',
        'La clôture automatique lors des limites ferme les trades attribués au canal côté TScopier mais ne annule pas les pertes de marché déjà subies. Les changements de configuration prennent effet après enregistrement — les brouillons non sauvegardés ne protègent pas votre compte.',
      ],
    },
    {
      title: 'Restez impliqué pendant la copie',
      paragraphs: [
        'La copie automatique n’est pas du « configurer et oublier ». Surveillez positions ouvertes, capital, marge et Copier Logs régulièrement. Intervenez chez votre courtier si les conditions changent ou si vous n’acceptez plus l’exposition du fournisseur.',
        'Si vous ne pouvez pas superviser activement votre compte, copier des signaux en direct peut ne pas vous convenir.',
      ],
    },
    {
      title: 'Améliorer vos chances (pas un conseil)',
      paragraphs: [
        'Commencez en démo ou avec la plus petite taille live que vous pouvez vous permettre de perdre. Évaluez les canaux dans le temps ; utilisez les backtests ; activez perte maximale et objectifs de profit ; ajustez les filtres ; diversifiez les fournisseurs plutôt que concentrer le risque.',
        'Lisez les raisons de skip dans Copier Logs quand les signaux ne passent pas. Gardez des attentes réalistes — de petits avantages constants avec un risque strict diffèrent fortement du marketing « enrichissement rapide ».',
      ],
    },
  ],
  closing:
    'En utilisant TScopier, vous reconnaissez que le trading est risqué, que les fournisseurs de signaux peuvent être peu fiables ou trompeurs, et que vous acceptez l’entière responsabilité de tous les trades sur vos comptes liés.',
}
