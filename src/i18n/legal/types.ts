export interface LegalDocumentSection {
  title: string
  paragraphs: string[]
}

export interface LegalDocumentPageTranslations {
  title: string
  lastUpdated: string
  intro: string
  sections: LegalDocumentSection[]
  closing?: string
  contact: {
    title: string
    company: string
    ein: string
    address: string
    phone: string
    emailSupport: string
    emailLegal: string
    emailDisputes: string
  }
}
