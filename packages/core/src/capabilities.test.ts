import { describe, expect, it } from "vitest";
import { CAPABILITY_TAXONOMY, capabilitiesOfPacks, customCapabilityDefinition, detectCapabilities, detectWithDefinitions, DETERMINISTIC_CONFIDENCE, looksPartiallyLoaded, type CapabilityPack } from "./capabilities.js";

const BOTH: CapabilityPack[] = ["general", "call-answering"];
const keys = (text: string, packs: CapabilityPack[] = BOTH) => detectCapabilities(text, packs).map((m) => m.key).sort();

describe("detectCapabilities (Phase 29 F1)", () => {
  it("reads a Spanish telephone-secretary page", () => {
    const text =
      "Atención telefónica personalizada para su negocio. Contestamos sus llamadas en nombre de su empresa y filtramos las llamadas que no son importantes. " +
      "Gestión de agenda y citas. Avisos por SMS y por email. Sin permanencia. Cobertura 24 horas al día. Integración con sus herramientas de gestión.";
    expect(keys(text)).toEqual(
      expect.arrayContaining(["call_answering", "in_name_of_company", "call_filtering", "appointment_booking", "sms_email_alerts", "no_commitment", "support_24_7", "crm_integration"]),
    );
  });

  it("reads a French telephone-secretary page", () => {
    const text =
      "Accueil personnalisé à votre nom par des standardistes basées en France. Prise de messages par e-mail, transfert d'appels et gestion des urgences. " +
      "Espace client et reporting dédié. Sans engagement, essai gratuit de 30 jours. Disponible 24h/24 et 7j/7, en français et anglais.";
    expect(keys(text)).toEqual(
      expect.arrayContaining(["in_name_of_company", "human_agents", "message_taking", "call_transfer", "urgent_calls", "call_tracking_platform", "no_commitment", "free_trial", "support_24_7"]),
    );
    expect(keys(text)).not.toContain("outbound_calls");
  });

  it("reads an English page and respects the enabled packs", () => {
    const text = "We answer your calls 24/7 with human operators. Try it for free. Integrates with Zapier. Data protection compliant (GDPR).";
    expect(keys(text)).toEqual(expect.arrayContaining(["call_answering", "support_24_7", "human_agents", "free_trial", "crm_integration", "gdpr"]));
    expect(keys(text, ["general"])).toEqual(["crm_integration", "free_trial", "gdpr", "support_24_7"]);
    expect(keys(text, [])).toEqual([]);
  });

  it("recognises the other ways a telephone service says it answers calls", () => {
    for (const text of ["Découvrez les bénéfices d'un accueil téléphonique professionnel.", "Notre service téléphonique prend en charge vos appels.", "Prise d'appels personnalisés pour votre cabinet.", "Servicio telefónico para autónomos.", "Our telephone answering service for small firms."]) {
      expect(keys(text, ["call-answering"])).toContain("call_answering");
    }
    expect(keys("Our pricing page has a service plan.", ["call-answering"])).not.toContain("call_answering");
  });

  it("shows the passage that justifies each capability, not just a yes", () => {
    const text = "Lorem ipsum ".repeat(20) + "Nuestro servicio incluye transferencia de llamadas a su móvil cuando usted lo indique. " + "dolor sit ".repeat(20);
    const [match] = detectCapabilities(text, ["call-answering"]).filter((m) => m.key === "call_transfer");
    expect(match!.evidence).toContain("transferencia de llamadas a su móvil");
    expect(match!.evidence.length).toBeLessThan(330);
    expect(match!.evidence.startsWith("…")).toBe(true);
    expect(match!.confidence).toBe(DETERMINISTIC_CONFIDENCE);
  });

  it("does not claim a capability the page denies", () => {
    expect(keys("No ofrecemos 24/7 ni transferencia de llamadas.")).toEqual([]);
    expect(keys("We do not offer a free trial.")).toEqual([]);
    expect(keys("Pas de transfert d'appels, pas d'essai gratuit.")).toEqual([]);
    expect(keys("Le service n'est pas disponible 24h/24.")).not.toContain("support_24_7");
  });

  it("does claim commitments written as negations, because that is what they say", () => {
    expect(keys("Contratación sin permanencia.")).toContain("no_commitment");
    expect(keys("Tarifs sans engagement de durée.")).toContain("no_commitment");
    expect(keys("No long-term contract, cancel anytime.")).toContain("no_commitment");
  });

  it("matches whole words only and ignores case", () => {
    expect(keys("RAPID APIs and capital")).not.toContain("api_access"); // "APIs" is not the word API
    expect(keys("Our API is documented")).toContain("api_access");
    expect(keys("ESSAI GRATUIT pendant 14 jours")).toContain("free_trial");
    expect(keys("therapist")).toEqual([]);
  });

  it("finds nothing in text that says nothing, and does not repeat a capability", () => {
    expect(keys("Welcome to our site. Contact us for more information.")).toEqual([]);
    const twice = detectCapabilities("24/7 support. We are available 24/7.", ["general"]);
    expect(twice.filter((m) => m.key === "support_24_7")).toHaveLength(1);
  });

  it("recognises a page that was captured before it was fully built", () => {
    expect(looksPartiallyLoaded("Compare plans Loading content... Starter Sign up")).toBe(true);
    expect(looksPartiallyLoaded("Loading…")).toBe(true);
    expect(looksPartiallyLoaded("Please wait... we are preparing your page")).toBe(true);
    expect(looksPartiallyLoaded("Fast loading times and a load balancer for every plan")).toBe(false);
    expect(looksPartiallyLoaded("")).toBe(false);
  });

  it("runs an organization's own capability by its phrases, as literal text, with the page's sentence as evidence", () => {
    const def = customCapabilityDefinition({ key: "custom:x1", label: "Answers in Catalan", description: "Takes calls in Catalan", phrases: ["en catalán", "C++ (beta)", "ab"] });
    expect(def).toMatchObject({ key: "custom:x1", pack: "custom" });
    expect(def.patterns).toHaveLength(2); // "ab" is too short to be a phrase
    const hit = detectWithDefinitions("Atendemos EN   catalán y castellano. Compatible con C++ (beta).", [def]);
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ key: "custom:x1", confidence: DETERMINISTIC_CONFIDENCE });
    expect(hit[0]!.evidence).toContain("catalán");
    expect(detectWithDefinitions("No atendemos en catalán.", [def])).toEqual([]); // a negation in the clause is not a claim
    expect(detectWithDefinitions("C+ (beta)", [def])).toEqual([]); // regex characters are not operators
    expect(detectWithDefinitions("anything", [customCapabilityDefinition({ key: "custom:x2", label: "Empty", description: "No phrases", phrases: [] })])).toEqual([]);
  });

  it("uses the edited phrases of a custom capability that keeps its key", () => {
    const v1 = customCapabilityDefinition({ key: "custom:x3", label: "L", description: "d", phrases: ["alpha beta"] });
    const v2 = customCapabilityDefinition({ key: "custom:x3", label: "L", description: "d", phrases: ["gamma delta"] });
    expect(detectWithDefinitions("alpha beta", [v1])).toHaveLength(1);
    expect(detectWithDefinitions("alpha beta", [v2])).toEqual([]);
    expect(detectWithDefinitions("gamma delta", [v2])).toHaveLength(1);
  });

  it("has a consistent taxonomy: unique keys, a label, patterns that compile, and a pack and category each", () => {
    const seen = new Set<string>();
    for (const c of CAPABILITY_TAXONOMY) {
      expect(seen.has(c.key)).toBe(false);
      seen.add(c.key);
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.patterns.length).toBeGreaterThan(0);
      expect(() => new RegExp(`(?:${c.patterns.join("|")})`, "iu")).not.toThrow();
    }
    expect(capabilitiesOfPacks(["general"]).every((c) => c.pack === "general")).toBe(true);
    expect(capabilitiesOfPacks(BOTH)).toHaveLength(CAPABILITY_TAXONOMY.length);
  });
});
