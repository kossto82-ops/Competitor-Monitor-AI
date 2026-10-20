/**
 * Phase 29 F1: what a competitor says its service can do, as a fixed list of capabilities found in the page text
 * by deterministic rules (Spanish, French and English), each with the sentence that shows it.
 *
 * Deterministic first, like everything that runs on every scan: no model is involved, so the same text always
 * gives the same answer and every "yes" can be shown. The honest limit is stated in the type: a capability that
 * is not found means "the page does not say so", never "the competitor does not offer it".
 */
export const CAPABILITY_PACKS = ["general", "call-answering"] as const;
export type CapabilityPack = (typeof CAPABILITY_PACKS)[number];

export const CAPABILITY_CATEGORIES = ["COVERAGE", "SERVICE", "AUTOMATION", "INTEGRATION", "COMMERCIAL"] as const;
export type CapabilityCategory = (typeof CAPABILITY_CATEGORIES)[number];

export interface CapabilityDefinition {
  key: string;
  label: string;
  category: CapabilityCategory;
  pack: CapabilityPack;
  /** Phrases that show it, in every language the product reads. Matched case-insensitively, as whole words. */
  patterns: string[];
  /**
   * Most capabilities are not claimed when the phrase sits right after a negation ("no 24/7", "pas de transfert").
   * Phrases that ARE a negation ("sin permanencia", "sans engagement") are exempt.
   */
  allowNegation?: boolean;
}

const def = (d: CapabilityDefinition): CapabilityDefinition => d;

export const CAPABILITY_TAXONOMY: readonly CapabilityDefinition[] = [
  // ---- general: any B2B service -------------------------------------------------------------------------------
  def({ key: "free_trial", label: "Free trial", category: "COMMERCIAL", pack: "general", patterns: ["free trial", "try (?:it )?for free", "prueba gratuita", "prueba gratis", "probar gratis", "pru[eé]belo gratis", "essai gratuit", "essayez gratuitement", "\\d+ jours? d'essai", "\\d+ d[ií]as de prueba", "essai gratuit de \\d+ jours"] }),
  def({ key: "no_commitment", label: "No long-term commitment", category: "COMMERCIAL", pack: "general", allowNegation: true, patterns: ["no (?:long[- ]term )?(?:contract|commitment|lock-in)", "cancel (?:at )?any ?time", "sin permanencia", "sin compromiso de permanencia", "cancela(?:ble)? cuando quieras", "sans engagement", "sans dur[eé]e d'engagement", "r[eé]siliable [aà] tout moment", "sans permanence"] }),
  def({ key: "money_back", label: "Money-back guarantee", category: "COMMERCIAL", pack: "general", patterns: ["money[- ]back guarantee", "garant[ií]a de devoluci[oó]n", "satisfecho o reembolsado", "satisfait ou rembours[eé]"] }),
  def({ key: "support_24_7", label: "Support or availability 24/7", category: "COVERAGE", pack: "general", patterns: ["24 ?/ ?7", "24 ?h(?:oras)? ?/ ?24", "24 ?h ?(?:sobre|sur) ?24", "24 hours a day", "all day,? every day", "7 ?j(?:ours)? ?/ ?7", "7 d[ií]as (?:a la|por) semana", "las 24 horas", "24h/24", "24 horas al d[ií]a", "(?:de )?jour et de nuit", "d[ií]a y noche"] }),
  def({ key: "multilingual", label: "Multiple languages", category: "SERVICE", pack: "general", patterns: ["multilingual", "multiling[uü]e", "fran[cç]ais et anglais", "french and english", "espa[nñ]ol e ingl[eé]s", "en plusieurs langues", "en varios idiomas", "varios idiomas", "plusieurs langues", "english[- ]speaking", "bilingu[ea]"] }),
  def({ key: "gdpr", label: "GDPR / data protection", category: "COMMERCIAL", pack: "general", patterns: ["gdpr", "rgpd", "rgpd", "data protection", "protecci[oó]n de datos", "protection des donn[eé]es"] }),
  def({ key: "api_access", label: "API", category: "INTEGRATION", pack: "general", patterns: ["\\bAPI\\b", "api access", "api rest"] }),
  def({ key: "crm_integration", label: "Integrations (CRM / business tools)", category: "INTEGRATION", pack: "general", patterns: ["integrat(?:es|ion|ions) with", "\\bCRM\\b", "zapier", "integraci[oó]n(?:es)? con", "int[eé]gration(?:s)? (?:avec|[aà])", "herramientas de gesti[oó]n", "outils de gestion", "connect(?:s|ed)? to your"] }),
  def({ key: "mobile_app", label: "Mobile app", category: "SERVICE", pack: "general", patterns: ["mobile app", "app (?:m[oó]vil|para m[oó]vil)", "application mobile", "iOS and Android", "\\bapp\\b (?:gratuita|gratuite|free)"] }),
  def({ key: "ai_assistant", label: "AI / virtual assistant", category: "AUTOMATION", pack: "general", patterns: ["artificial intelligence", "inteligencia artificial", "intelligence artificielle", "\\bAI[- ](?:powered|agent|assistant)", "asistente virtual (?:con|de) IA", "assistant (?:virtuel )?(?:IA|intelligent)", "agente(?:s)? de IA", "agent(?:s)? IA", "voicebot", "chatbot"] }),

  // ---- call answering: telephone secretarial services -------------------------------------------------------------
  def({ key: "call_answering", label: "Answers calls on your behalf", category: "SERVICE", pack: "call-answering", patterns: ["answer(?:s|ing)? (?:your )?calls", "atenci[oó]n telef[oó]nica", "recepci[oó]n de llamadas", "contestamos (?:sus|tus) llamadas", "descolgamos", "r[eé]ponse t[eé]l[eé]phonique", "permanence t[eé]l[eé]phonique", "r[eé]ceptionn?e? (?:vos|les) appels", "d[eé]crochons", "standard t[eé]l[eé]phonique", "secretar[ií]a (?:telef[oó]nica|virtual)", "secr[eé]tariat t[eé]l[eé]phonique", "t[eé]l[eé]secr[eé]tariat", "accueil t[eé]l[eé]phonique", "service t[eé]l[eé]phonique", "prise (?:en charge )?d'appels", "r[eé]ception d'appels", "gestion des appels", "answering service", "telephone answering", "servicio telef[oó]nico", "atenci[oó]n de llamadas", "gesti[oó]n de llamadas", "centralita (?:telef[oó]nica|virtual)"] }),
  def({ key: "in_name_of_company", label: "Answers in the company's name", category: "SERVICE", pack: "call-answering", patterns: ["en nombre de su empresa", "en nombre de tu empresa", "con el nombre de su empresa", "au nom de votre (?:entreprise|soci[eé]t[eé]|cabinet)", "in your company's name", "on behalf of your (?:company|business)", "en su nombre", "en votre nom", "a votre nom", "à votre nom"] }),
  def({ key: "call_transfer", label: "Call transfer", category: "SERVICE", pack: "call-answering", patterns: ["call transfer", "transfer(?:s|ring)? calls", "transferencia de llamadas", "transferimos (?:las |sus )?llamadas", "desv[ií]o de llamadas", "transfert d'appels", "transf[eé]rer les appels", "transf[eé]rons (?:vos |les )?appels", "renvoi d'appels"] }),
  def({ key: "call_filtering", label: "Call screening / filtering", category: "SERVICE", pack: "call-answering", patterns: ["call screening", "filtering calls", "filtrado de llamadas", "filtramos (?:las |sus )?llamadas", "filtrage d'appels", "filtrage des appels", "filtre(?:r|ons)? (?:vos |les )?appels"] }),
  def({ key: "message_taking", label: "Takes messages", category: "SERVICE", pack: "call-answering", patterns: ["take messages", "taking messages", "toma de mensajes", "tomamos nota de los mensajes", "recogemos (?:sus |los )?mensajes", "prise de messages", "prendre (?:vos |les )?messages", "transmission des messages"] }),
  def({ key: "appointment_booking", label: "Appointment booking", category: "SERVICE", pack: "call-answering", patterns: ["appointment(?:s)? (?:booking|scheduling|management)", "book(?:s|ing)? appointments", "gesti[oó]n de (?:citas|agenda)", "agenda(?:s)? (?:y|de) citas", "reserva de citas", "citas previas", "prise de rendez-vous", "gestion (?:de l'|des |d')?(?:agenda|rendez-vous)", "gestion des rdv", "rdv"] }),
  def({ key: "sms_email_alerts", label: "Notifications by SMS or email", category: "SERVICE", pack: "call-answering", patterns: ["sms (?:or|and|y|o|et|ou) (?:e-?mail|correo)", "avisos? por (?:sms|correo|email|e-mail)", "(?:e-?mail|correo) (?:o|y) sms", "notifications? par (?:sms|e-?mail)", "alertes? par (?:sms|e-?mail)", "mensajes por correo electr[oó]nico o sms", "par e-mail ou sms"] }),
  def({ key: "urgent_calls", label: "Urgent calls handled", category: "SERVICE", pack: "call-answering", patterns: ["urgent calls", "emergency calls", "llamadas urgentes", "urgencias", "appels urgents", "urgences", "gestion des urgences", "astreinte"] }),
  def({ key: "human_agents", label: "Human operators", category: "SERVICE", pack: "call-answering", patterns: ["human (?:agents?|operators?|receptionists?)", "atenci[oó]n humana", "agentes humanos", "personas reales", "operadores? (?:humanos?|profesionales)", "standardistes?", "op[eé]rateurs? (?:humains?|professionnels?)", "[eé]quipes? (?:bas[eé]es?|situ[eé]es?) en France", "personnes? r[eé]elles?", "interlocuteur d[eé]di[eé]", "interlocutor dedicado"] }),
  def({ key: "outbound_calls", label: "Outbound calls", category: "SERVICE", pack: "call-answering", patterns: ["outbound calls", "llamadas (?:salientes|a clientes)", "appels sortants", "rappel(?:s)? de vos clients", "emisi[oó]n de llamadas"] }),
  def({ key: "call_tracking_platform", label: "Online platform to follow calls", category: "INTEGRATION", pack: "call-answering", patterns: ["online (?:platform|portal|dashboard)", "customer portal", "registro de llamadas", "(?:plataforma|[aá]rea|portal) (?:online|web|de cliente)", "espacio cliente", "espace client", "plateforme (?:de suivi|en ligne)", "suivi des appels", "reporting"] }),
  def({ key: "volume_pricing", label: "Plans by call volume", category: "COMMERCIAL", pack: "call-answering", patterns: ["by (?:number of )?calls", "per call", "planes por volumen", "volumen de llamadas", "por llamada", "n[uú]mero de llamadas", "selon (?:le )?(?:volume|nombre) d'appels", "volume d'appels", "nombre d'appels", "forfaits? (?:selon|adapt[eé]s?)", "(?:\\d+|\\d+ ?[aà] ?\\d+) appels (?:inclus|par mois|/ ?mois)", "\\d+ llamadas (?:incluidas|al mes|recibidas)"] }),
  def({ key: "sector_medical", label: "Serves medical professionals", category: "SERVICE", pack: "call-answering", patterns: ["medical (?:practices?|professionals?)", "consultas? m[eé]dicas?", "profesionales (?:sanitarios|de la salud)", "cabinets? m[eé]dicaux", "professions? m[eé]dicales?", "professionnels? de sant[eé]", "m[eé]decins?"] }),
  def({ key: "sector_legal", label: "Serves legal professionals", category: "SERVICE", pack: "call-answering", patterns: ["law (?:firms?|offices?)", "abogados", "despachos? (?:jur[ií]dicos|de abogados)", "avocats?", "cabinets? d'avocats", "notaires?"] }),
];

export interface CapabilityMatch {
  key: string;
  /** The text around the phrase that showed it: the evidence a person can read. */
  evidence: string;
  /** What decided it. A deterministic phrase match is high but not certain: wording can be marketing. */
  confidence: number;
}

// A negation only counts inside its own clause: "Sin permanencia, cobertura 24 horas" does not deny the coverage.
const NEGATION_BEFORE =
  /(?:\b(?:no|not|never|without|n't|sin|sans|nunca|jamais|nicht|kein|ni)\b|\bpas (?:de|d')|\bnon\b|\bn['’]\p{L}+ pas\b|\bne \p{L}+ pas\b|\bisn't\b)\s*(?:\S+\s+){0,2}$/iu;

const EVIDENCE_RADIUS = 110;
export const DETERMINISTIC_CONFIDENCE = 0.85;

/** The words just before `start` in the same sentence, at most 30 characters back. */
function sameSentenceBefore(text: string, start: number): string {
  const window = text.slice(Math.max(0, start - 30), start);
  const lastBreak = Math.max(window.lastIndexOf("."), window.lastIndexOf(";"), window.lastIndexOf(":"), window.lastIndexOf("!"), window.lastIndexOf(","), window.lastIndexOf("?"), window.lastIndexOf("\n"));
  return lastBreak === -1 ? window : window.slice(lastBreak + 1);
}

function snippet(text: string, start: number, end: number): string {
  const from = Math.max(0, start - EVIDENCE_RADIUS);
  const to = Math.min(text.length, end + EVIDENCE_RADIUS);
  const piece = text.slice(from, to).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${piece}${to < text.length ? "…" : ""}`;
}

const compiled = new Map<string, RegExp>();
function regexFor(definition: CapabilityDefinition): RegExp {
  let re = compiled.get(definition.key);
  if (!re) {
    re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${definition.patterns.join("|")})(?![\\p{L}\\p{N}])`, "giu");
    compiled.set(definition.key, re);
  }
  return re;
}

/** The capabilities of the enabled packs that this text claims, each with the passage that shows it. */
export function detectCapabilities(text: string, packs: readonly CapabilityPack[] = ["general"], taxonomy: readonly CapabilityDefinition[] = CAPABILITY_TAXONOMY): CapabilityMatch[] {
  const enabled = new Set<string>(packs);
  const found: CapabilityMatch[] = [];
  for (const definition of taxonomy) {
    if (!enabled.has(definition.pack)) continue;
    const re = regexFor(definition);
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      const start = match.index ?? 0;
      if (!definition.allowNegation && NEGATION_BEFORE.test(sameSentenceBefore(text, start))) continue; // "no 24/7": never claimed
      found.push({ key: definition.key, evidence: snippet(text, start, start + match[0].length), confidence: DETERMINISTIC_CONFIDENCE });
      break; // one passage per capability is the evidence; the first is enough
    }
  }
  return found;
}

/**
 * A page that still shows a "Loading content..." stand-in was captured before all of it was built (Brevo serves
 * its feature lists that way on some requests). What it does say is real; what it does not say proves nothing.
 */
export function looksPartiallyLoaded(text: string): boolean {
  return /(?<![\p{L}])(?:loading content|loading\s*(?:\.{3}|\u2026)|please wait\s*(?:\.{3}|\u2026))/iu.test(text);
}

export function capabilityByKey(key: string): CapabilityDefinition | undefined {
  return CAPABILITY_TAXONOMY.find((c) => c.key === key);
}

export function capabilitiesOfPacks(packs: readonly CapabilityPack[]): CapabilityDefinition[] {
  const enabled = new Set<string>(packs);
  return CAPABILITY_TAXONOMY.filter((c) => enabled.has(c.pack));
}

/** Misses in a row before a capability is called gone: a single bad capture (a partial render) must not remove it. */
export const CAPABILITY_MISSES_BEFORE_ABSENT = 2;
