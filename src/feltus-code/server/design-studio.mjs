import crypto from "node:crypto";
import path from "node:path";
import { redactSecrets } from "./security.mjs";

export const DESIGN_STATE_CONTRACT = "feltus.design-state/v1";
export const DESIGN_PROPOSAL_CONTRACT = "feltus.design-proposal/v1";
export const DESIGN_COMPONENT_TYPES = Object.freeze([
  "page", "section", "hero", "header", "navigation", "sidebar", "card", "form",
  "table", "button", "media", "dashboard-region", "modal", "footer"
]);
export const DESIGN_BREAKPOINTS = Object.freeze({ desktop: 1024, tablet: 760, mobile: 420 });
export const DESIGN_SYNC_STATES = Object.freeze([
  "SYNCED", "CANVAS_CHANGED", "CODE_CHANGED", "RECONCILIATION_REQUIRED", "CONFLICT", "VALIDATING"
]);

const RECIPE_FAMILIES = Object.freeze([
  { id: "saas", name: "SaaS", hue: 224, fits: ["saas", "software", "subscription", "web_application"] },
  { id: "dashboard", name: "Dashboard", hue: 212, fits: ["dashboard", "analytics", "reporting", "admin"] },
  { id: "marketplace", name: "Marketplace", hue: 161, fits: ["marketplace", "multi-vendor", "services"] },
  { id: "commerce", name: "Commerce", hue: 28, fits: ["commerce", "e-commerce", "retail", "store"] },
  { id: "portfolio", name: "Portfolio", hue: 282, fits: ["portfolio", "creative", "agency"] },
  { id: "services", name: "Professional Services", hue: 197, fits: ["professional services", "consulting", "client portal"] },
  { id: "health", name: "Healthcare", hue: 151, fits: ["healthcare", "wellness", "care"] },
  { id: "education", name: "Education", hue: 43, fits: ["education", "learning", "course"] },
  { id: "finance", name: "Finance", hue: 225, fits: ["finance", "fintech", "accounting"] },
  { id: "media", name: "Media", hue: 342, fits: ["media", "publishing", "video", "audio"] },
  { id: "directory", name: "Directory", hue: 185, fits: ["directory", "listing", "catalog"] },
  { id: "booking", name: "Booking", hue: 261, fits: ["booking", "appointments", "scheduling"] },
  { id: "community", name: "Community", hue: 328, fits: ["community", "membership", "social"] },
  { id: "internal", name: "Internal Tools", hue: 207, fits: ["internal tools", "operations", "workflow"] },
  { id: "consumer", name: "Consumer", hue: 7, fits: ["consumer", "mobile", "content", "personal"] }
]);

const RECIPE_DIRECTIONS = Object.freeze([
  { id: "conservative", name: "Conservative", saturation: 47, lightness: 39, density: "comfortable", radius: "8px", heading: "Inter, ui-sans-serif, sans-serif", shadow: "0 2px 8px #17203312" },
  { id: "editorial", name: "Editorial", saturation: 54, lightness: 35, density: "spacious", radius: "4px", heading: "Georgia, ui-serif, serif", shadow: "0 8px 24px #17203318" },
  { id: "modern", name: "Modern", saturation: 67, lightness: 43, density: "comfortable", radius: "12px", heading: "Inter, ui-sans-serif, sans-serif", shadow: "0 12px 30px #17203318" },
  { id: "bold", name: "Bold", saturation: 78, lightness: 42, density: "compact", radius: "8px", heading: "Inter, ui-sans-serif, sans-serif", shadow: "0 12px 32px #17203324" },
  { id: "premium", name: "Premium", saturation: 52, lightness: 68, density: "spacious", radius: "16px", heading: "Georgia, ui-serif, serif", shadow: "0 18px 40px #070b142e", dark: true }
]);

const FONT_STACKS = Object.freeze([
  "Inter, ui-sans-serif, sans-serif",
  "Arial, Helvetica, sans-serif",
  "Georgia, ui-serif, serif",
  "ui-monospace, SFMono-Regular, monospace",
  "system-ui, sans-serif"
]);
const SAFE_TAGS = new Set(["article", "aside", "button", "div", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "img", "input", "main", "nav", "p", "section", "table"]);
const VOID_TAGS = new Set(["hr", "img", "input"]);
const VARIANTS = Object.freeze({
  page: ["default", "wide", "reading"], section: ["default", "compact", "spacious"], hero: ["split", "centered", "stacked", "compact"],
  header: ["default", "compact", "centered"], navigation: ["horizontal", "centered", "compact", "sidebar"], sidebar: ["default", "compact", "rail"],
  card: ["elevated", "outlined", "flat", "compact"], form: ["stacked", "inline", "compact"], table: ["comfortable", "compact", "striped"],
  button: ["primary", "secondary", "outline", "quiet"], media: ["wide", "contained", "cover"], "dashboard-region": ["grid", "wide", "compact"],
  modal: ["default", "compact", "wide"], footer: ["default", "compact", "columns"]
});
const COMPONENT_DEFAULTS = Object.freeze({ alignment: "start", layout: "stack", width: "full", padding: "24px", gap: "16px", visible: true, background: "surface", color: "text", radius: "medium", shadow: "small", font_size: "16px" });
const DESIGN_STATE_MAX_BYTES = 18000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hslToHex(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360;
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - chroma / 2;
  const rgb = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x]
    : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return `#${rgb.map(value => Math.round((value + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function makeRecipe(family, direction) {
  const dark = direction.dark === true;
  const hue = family.hue + (direction.id === "editorial" ? -8 : direction.id === "bold" ? 9 : direction.id === "premium" ? 16 : 0);
  const primary = hslToHex(hue, direction.saturation, direction.lightness);
  const accent = hslToHex(hue + 35, Math.min(direction.saturation + 7, 86), Math.max(35, direction.lightness - 3));
  return Object.freeze({
    id: `${family.id}-${direction.id}`,
    name: `${family.name} ${direction.name}`,
    family: family.id,
    direction: direction.id,
    tags: Object.freeze([...family.fits, direction.id]),
    recommended_for: Object.freeze([...family.fits]),
    tokens: Object.freeze({
      colors: Object.freeze({ primary, secondary: hslToHex(hue + 190, 35, dark ? 66 : 38), accent, surface: dark ? "#182131" : "#ffffff", background: dark ? "#101725" : "#f6f8fb", text: dark ? "#f1f4fa" : "#202a3b", muted: dark ? "#aab5c6" : "#667085", border: dark ? "#354156" : "#e1e6ee" }),
      typography: Object.freeze({ heading: direction.heading, body: "Inter, ui-sans-serif, sans-serif", base_size: "16px", line_height: "1.5", weight: direction.id === "bold" ? 650 : 500 }),
      spacing: Object.freeze({ unit: "4px", density: direction.density, page: direction.density === "compact" ? "24px" : "40px", section: direction.density === "spacious" ? "64px" : "40px", component: direction.density === "compact" ? "12px" : "20px" }),
      radii: Object.freeze({ small: direction.radius, medium: direction.id === "bold" ? "12px" : "8px", large: direction.id === "premium" ? "24px" : "16px", pill: "9999px" }),
      shadows: Object.freeze({ small: direction.shadow, medium: direction.shadow, large: `${direction.shadow}, 0 24px 48px #17203312` }),
      layout: Object.freeze({ content_width: "1200px", columns: 12, navigation: direction.id === "editorial" ? "editorial" : "horizontal", density: direction.density }),
      motion: Object.freeze({ duration: direction.id === "bold" ? "180ms" : "220ms", reduced_motion: true }),
      accessibility: Object.freeze({ visible_focus: true, minimum_target: "44px", contrast_target: "AA" })
    }),
    responsive: Object.freeze({ desktop: Object.freeze({ columns: 12, gap: "24px", page_padding: "40px" }), tablet: Object.freeze({ columns: 8, gap: "20px", page_padding: "24px" }), mobile: Object.freeze({ columns: 4, gap: "16px", page_padding: "16px" }) })
  });
}

export const DESIGN_RECIPES = Object.freeze(RECIPE_FAMILIES.flatMap(family =>
  RECIPE_DIRECTIONS.map(direction => makeRecipe(family, direction))
));

export const DEFAULT_BRAND_GUARDRAILS = Object.freeze({
  allowed_logos: [],
  allowed_colors: [],
  prohibited_colors: [],
  typography_rules: { allowed_heading_fonts: [...FONT_STACKS], allowed_body_fonts: [...FONT_STACKS] },
  spacing_rules: { allowed_density: ["compact", "comfortable", "spacious"] },
  component_rules: { allowed_types: [...DESIGN_COMPONENT_TYPES] },
  accessibility: { visible_focus: true, minimum_target: "44px", contrast_target: "AA" },
  locked_values: {}
});

function stringsFrom(value, result = []) {
  if (typeof value === "string") result.push(value.toLowerCase());
  else if (Array.isArray(value)) value.forEach(item => stringsFrom(item, result));
  else if (value && typeof value === "object") Object.values(value).forEach(item => stringsFrom(item, result));
  return result;
}

export function recommendDesignRecipes({ application = {}, intelligence = {}, capabilities = {} } = {}) {
  const classification = intelligence.classification || intelligence || {};
  const vocabulary = stringsFrom({
    app_type: application.type || application.app_type,
    industry: classification.industry || classification.core_industry,
    sub_industry: classification.sub_industry,
    archetypes: classification.archetypes,
    business_models: classification.business_models,
    audiences: classification.audiences,
    workflows: classification.workflow_patterns,
    capabilities
  });
  const confidence = Number.isFinite(classification.confidence) ? classification.confidence : null;
  const scored = DESIGN_RECIPES.map(recipe => {
    let score = 0;
    const reasons = [];
    for (const tag of recipe.tags) {
      if (vocabulary.some(term => term.includes(tag) || tag.includes(term))) {
        score += recipe.recommended_for.includes(tag) ? 3 : 1;
        if (!reasons.includes(tag)) reasons.push(tag);
      }
    }
    if (capabilities?.data_models && ["marketplace", "commerce", "dashboard", "internal"].includes(recipe.family)) score += 1;
    if (capabilities?.knowledge_documents && ["media", "education", "services"].includes(recipe.family)) score += 1;
    return { recipe_id: recipe.id, score, reasons: reasons.slice(0, 4) };
  }).sort((a, b) => b.score - a.score || a.recipe_id.localeCompare(b.recipe_id));
  const topScore = scored[0]?.score || 0;
  return scored.slice(0, 6).map((item, index) => ({
    ...item,
    recommendation: index === 0 && topScore > 0 ? "Recommended" : "Suggestion",
    confidence: confidence !== null && confidence < 0.55 || topScore === 0 ? "low" : index < 3 ? "medium" : "low"
  }));
}

function cssColor(value, name) {
  if (typeof value !== "string" || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) {
    throw Object.assign(new Error(`${name} must be a CSS hex color.`), { code: "DESIGN_VALUE_INVALID" });
  }
  return value.toLowerCase();
}

function safeId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
}

export function designStateHash(state) {
  return sha256(JSON.stringify(sorted(state)));
}

function attr(attributes, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(attributes);
  return match?.[2] || null;
}

function contractRanges(file) {
  if (!/\.html?$/i.test(file.path)) return [];
  const matches = [];
  const openTags = /<([a-z][a-z0-9-]*)\b([^>]*)>/gi;
  let match;
  while ((match = openTags.exec(file.content))) {
    const [, tag, attributes] = match;
    if (!SAFE_TAGS.has(tag.toLowerCase())) continue;
    const id = attr(attributes, "data-feltus-id");
    if (!id || !safeId(id)) continue;
    const closing = new RegExp(`<\\/?${tag}\\b[^>]*>`, "ig");
    closing.lastIndex = openTags.lastIndex;
    let depth = 1;
    let close = null;
    let token;
    if (!VOID_TAGS.has(tag.toLowerCase())) {
      while ((token = closing.exec(file.content))) {
        if (/^<\//.test(token[0])) depth -= 1;
        else if (!/\/\s*>$/.test(token[0])) depth += 1;
        if (depth === 0) { close = token; break; }
      }
    }
    const end = close ? closing.lastIndex : openTags.lastIndex;
    const inner = file.content.slice(openTags.lastIndex, close ? close.index : openTags.lastIndex);
    const textContent = VOID_TAGS.has(tag.toLowerCase()) || /<\s*[a-z][^>]*>/i.test(inner) ? null : inner.trim().replace(/\s+/g, " ");
    matches.push({
      path: file.path,
      id,
      type: attr(attributes, "data-feltus-component") || "section",
      page_id: attr(attributes, "data-feltus-page") || (file.path.toLowerCase().includes("index") ? "home" : path.basename(file.path, path.extname(file.path))),
      variant: attr(attributes, "data-feltus-variant") || "default",
      managed: attr(attributes, "data-feltus-managed") === "v1",
      tag: tag.toLowerCase(),
      content: textContent,
      content_sha256: sha256(inner),
      source_sha256: sha256(file.content.slice(match.index, end)),
      start: match.index,
      end,
      open_end: openTags.lastIndex,
      close_start: close ? close.index : openTags.lastIndex
    });
  }
  return matches;
}

export function discoverDesignComponents(files = []) {
  return files.flatMap(contractRanges);
}

export function managedDesignSourceSnippets(files = [], components = [], { pageId = null, componentId = null, maxBytes = 24000 } = {}) {
  const selectedIds = new Set(componentId ? [componentId] : components.filter(component => component.ownership_state === "FELTUS_MANAGED" && (!pageId || component.page_id === pageId)).map(component => component.id));
  const byId = new Map(components.map(component => [component.id, component]));
  const sourceById = new Map(discoverDesignComponents(files).map(source => [source.id, source]));
  let remaining = Math.max(0, Math.min(Number(maxBytes) || 0, 48000));
  const excerpts = [];
  for (const id of selectedIds) {
    if (remaining <= 0) break;
    const stateComponent = byId.get(id);
    const source = sourceById.get(id);
    const file = files.find(item => item.path === source?.path);
    if (!stateComponent || !source || !file) continue;
    const markup = redactSecrets(file.content.slice(source.start, source.end)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "<!-- script omitted -->")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "<!-- style omitted -->"));
    const safeMarkup = Buffer.byteLength(markup, "utf8") <= remaining ? markup : Buffer.from(markup, "utf8").subarray(0, remaining).toString("utf8");
    excerpts.push({ path: source.path, component_id: id, component_type: stateComponent.type, page_id: stateComponent.page_id, markup: safeMarkup, truncated: safeMarkup.length !== markup.length });
    remaining -= Buffer.byteLength(safeMarkup, "utf8");
  }
  return excerpts;
}

function componentRecord(source, ownership = "FELTUS_MANAGED") {
  const managed = source.managed && ownership === "FELTUS_MANAGED";
  const type = DESIGN_COMPONENT_TYPES.includes(source.type) ? source.type : "section";
  return {
    id: source.id,
    name: source.id.split(/[._-]/).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
    type,
    page_id: source.page_id,
    source_path: source.path,
    tag: source.tag,
    variant: VARIANTS[type]?.includes(source.variant) ? source.variant : "default",
    content: source.content !== null && source.content.length <= 300 ? source.content : null,
    ownership_state: managed ? "FELTUS_MANAGED" : "DEVELOPER_MANAGED",
    reconciliation_state: managed ? "AVAILABLE" : "REQUIRED",
    sync_state: managed ? "SYNCED" : "RECONCILIATION_REQUIRED",
    source_contract: { tag: source.tag, type: source.type, variant: source.variant, content_sha256: source.content_sha256, source_sha256: source.source_sha256, managed: source.managed },
    properties: {},
    responsive: {}
  };
}

function pagesFromComponents(components) {
  const pageIds = [...new Set(components.map(component => component.page_id || "home"))];
  return (pageIds.length ? pageIds : ["home"]).map(id => ({ id, path: id === "home" ? "/" : `/${id}`, title: id === "home" ? "Home" : id.replace(/[-_]/g, " "), component_ids: components.filter(component => component.page_id === id).map(component => component.id), configuration: {} }));
}

export function createDesignState({ application = {}, intelligence = {}, capabilities = {}, files = [], sourceIdentity = {} } = {}) {
  const recommendations = recommendDesignRecipes({ application, intelligence, capabilities });
  const recipe = DESIGN_RECIPES.find(item => item.id === recommendations[0]?.recipe_id) || DESIGN_RECIPES[0];
  const sources = discoverDesignComponents(files);
  const components = sources.map(source => componentRecord(source, source.managed ? "FELTUS_MANAGED" : "DEVELOPER_MANAGED"));
  return validateDesignState({
    contract: DESIGN_STATE_CONTRACT,
    revision: 1,
    active_recipe_id: recipe.id,
    profile: { id: recipe.id, name: recipe.name, kind: "recipe", base_recipe_ids: [recipe.id] },
    tokens: clone(recipe.tokens),
    global_styles: { max_content_width: recipe.tokens.layout.content_width, page_background: recipe.tokens.colors.background },
    responsive: clone(recipe.responsive),
    brand_guardrails: clone(DEFAULT_BRAND_GUARDRAILS),
    components,
    pages: pagesFromComponents(components),
    sync: { status: "SYNCED", source_workspace_id: sourceIdentity.workspace_id || null, source_branch: sourceIdentity.branch || null, source_checkpoint: sourceIdentity.commit || null, source_snapshot_sha256: sourceIdentity.snapshot_sha256 || null, classifier_version: sourceIdentity.classifier_version || null, source_clean: sourceIdentity.clean !== false, updated_at: new Date().toISOString() }
  });
}

export function validateDesignState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.contract !== DESIGN_STATE_CONTRACT) {
    throw Object.assign(new Error("Unsupported Design State contract."), { code: "DESIGN_STATE_INVALID" });
  }
  const state = clone(input);
  if (!Number.isInteger(state.revision) || state.revision < 1 || !DESIGN_RECIPES.some(recipe => recipe.id === state.active_recipe_id)) {
    throw Object.assign(new Error("Design State revision or active recipe is invalid."), { code: "DESIGN_STATE_INVALID" });
  }
  for (const key of ["primary", "secondary", "accent", "surface", "background", "text", "muted", "border"]) cssColor(state.tokens?.colors?.[key], `tokens.colors.${key}`);
  for (const key of ["heading", "body"]) {
    if (!FONT_STACKS.includes(state.tokens?.typography?.[key])) throw Object.assign(new Error(`Unsupported ${key} font stack.`), { code: "DESIGN_VALUE_INVALID" });
  }
  const isLength = value => typeof value === "string" && /^(?:0|[1-9][0-9]{0,3})px$/.test(value);
  const isShadow = value => typeof value === "string" && value.split(",").every(part => /^(?:0|[1-9][0-9]{0,2}px?)(?:\s+(?:0|[1-9][0-9]{0,2}px)){1,3}\s+#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(part.trim()));
  const tokens = state.tokens || {};
  if (!new Set(["12px", "14px", "16px", "18px", "20px", "24px"]).has(tokens.typography?.base_size) || !/^(?:1(?:\.[0-9]{1,2})?|2(?:\.0{1,2})?)$/.test(String(tokens.typography?.line_height)) || !Number.isInteger(tokens.typography?.weight) || tokens.typography.weight < 100 || tokens.typography.weight > 900) {
    throw Object.assign(new Error("Typography tokens must use supported sizes, line heights, and weights."), { code: "DESIGN_VALUE_INVALID" });
  }
  if (!isLength(tokens.spacing?.unit) || !["compact", "comfortable", "spacious"].includes(tokens.spacing?.density) || !["page", "section", "component"].every(key => isLength(tokens.spacing?.[key]))) {
    throw Object.assign(new Error("Spacing tokens must use supported values."), { code: "DESIGN_VALUE_INVALID" });
  }
  if (!["small", "medium", "large"].every(key => isLength(tokens.radii?.[key])) || tokens.radii?.pill !== "9999px" || !["small", "medium", "large"].every(key => isShadow(tokens.shadows?.[key]))) {
    throw Object.assign(new Error("Radius and shadow tokens must use supported values."), { code: "DESIGN_VALUE_INVALID" });
  }
  if (!isLength(tokens.layout?.content_width) || !Number.isInteger(tokens.layout?.columns) || tokens.layout.columns < 1 || tokens.layout.columns > 12 || !["editorial", "horizontal", "sidebar"].includes(tokens.layout?.navigation) || !["compact", "comfortable", "spacious"].includes(tokens.layout?.density)) {
    throw Object.assign(new Error("Layout tokens must use supported values."), { code: "DESIGN_VALUE_INVALID" });
  }
  if (!/^([1-9][0-9]{0,3})ms$/.test(tokens.motion?.duration) || typeof tokens.motion?.reduced_motion !== "boolean") {
    throw Object.assign(new Error("Motion tokens must use a bounded duration and reduced-motion preference."), { code: "DESIGN_VALUE_INVALID" });
  }
  if (tokens.accessibility?.visible_focus !== true || !isSafeMinimumTarget(tokens.accessibility?.minimum_target) || !["AA", "AAA"].includes(tokens.accessibility?.contrast_target)) {
    throw Object.assign(new Error("Accessibility tokens must preserve focus, target-size, and contrast defaults."), { code: "DESIGN_VALUE_INVALID" });
  }
  if (!Array.isArray(state.components) || state.components.length > 40 || !Array.isArray(state.pages) || state.pages.length > 40) {
    throw Object.assign(new Error("Design State exceeds its component or page limit."), { code: "DESIGN_STATE_INVALID" });
  }
  const componentIds = new Set();
  for (const component of state.components) {
    component.properties ||= {};
    component.responsive ||= {};
    if (!safeId(component.id) || componentIds.has(component.id) || !DESIGN_COMPONENT_TYPES.includes(component.type)) {
      throw Object.assign(new Error(`Design State contains an invalid or duplicate component identity: ${String(component.id)} (${String(component.type)}).`), { code: "DESIGN_STATE_INVALID" });
    }
    componentIds.add(component.id);
    if (!safeId(component.page_id) || !component.properties || typeof component.properties !== "object" || Array.isArray(component.properties) || !component.responsive || typeof component.responsive !== "object" || Array.isArray(component.responsive)) {
      throw Object.assign(new Error(`Component ${component.id} has invalid page or visual properties.`), { code: "DESIGN_STATE_INVALID" });
    }
    if (!["FELTUS_MANAGED", "DEVELOPER_MANAGED"].includes(component.ownership_state) || !["AVAILABLE", "REQUIRED", "NOT_REQUIRED"].includes(component.reconciliation_state)) {
      throw Object.assign(new Error(`Component ${component.id} has an invalid ownership or reconciliation state.`), { code: "DESIGN_STATE_INVALID" });
    }
    if (!DESIGN_SYNC_STATES.includes(component.sync_state)) throw Object.assign(new Error(`Component ${component.id} has an invalid sync state.`), { code: "DESIGN_STATE_INVALID" });
    if (!VARIANTS[component.type]?.includes(component.variant)) throw Object.assign(new Error(`Component ${component.id} has an invalid variant.`), { code: "DESIGN_STATE_INVALID" });
    for (const [property, value] of Object.entries(component.properties)) validateComponentProperty(component, property, value);
    for (const viewport of ["desktop", "tablet", "mobile"]) {
      component.responsive[viewport] ||= {};
      if (!component.responsive[viewport] || typeof component.responsive[viewport] !== "object" || Array.isArray(component.responsive[viewport])) throw Object.assign(new Error(`Component ${component.id} has invalid ${viewport} rules.`), { code: "DESIGN_STATE_INVALID" });
      for (const [property, value] of Object.entries(component.responsive[viewport])) {
        if (["content", "variant"].includes(property)) throw Object.assign(new Error("Content and variant are not responsive-only properties."), { code: "DESIGN_VALUE_INVALID" });
        validateComponentProperty(component, property, value);
      }
    }
    if (component.content !== null && (typeof component.content !== "string" || component.content.length > 300 || /[<>]/.test(component.content))) throw Object.assign(new Error(`Component ${component.id} contains unsupported text content.`), { code: "DESIGN_STATE_INVALID" });
    if (component.source_path !== null && component.source_path !== undefined && (typeof component.source_path !== "string" || component.source_path.startsWith("/") || component.source_path.includes(".."))) throw Object.assign(new Error(`Component ${component.id} has an invalid source path.`), { code: "DESIGN_STATE_INVALID" });
  }
  if (!state.responsive || !["desktop", "tablet", "mobile"].every(key => state.responsive[key] && typeof state.responsive[key] === "object")) {
    throw Object.assign(new Error("Design State must preserve desktop, tablet, and mobile rules."), { code: "DESIGN_STATE_INVALID" });
  }
  if (!state.brand_guardrails || typeof state.brand_guardrails !== "object" || Array.isArray(state.brand_guardrails)) {
    throw Object.assign(new Error("Brand Guardrails must be a structured object."), { code: "DESIGN_STATE_INVALID" });
  }
  if (!state.sync || !DESIGN_SYNC_STATES.includes(state.sync.status)) throw Object.assign(new Error("Design sync status is invalid."), { code: "DESIGN_STATE_INVALID" });
  for (const viewport of ["desktop", "tablet", "mobile"]) {
    const rules = state.responsive[viewport];
    if (!Number.isInteger(rules.columns) || rules.columns < 1 || rules.columns > 12 || !isLength(rules.gap) || !isLength(rules.page_padding)) throw Object.assign(new Error(`Responsive ${viewport} rules are invalid.`), { code: "DESIGN_VALUE_INVALID" });
  }
  validateBrandGuardrails(state.brand_guardrails);
  const contrastRank = { AA: 1, AAA: 2 };
  if (Number.parseInt(tokens.accessibility.minimum_target, 10) < Number.parseInt(state.brand_guardrails.accessibility.minimum_target, 10) || contrastRank[tokens.accessibility.contrast_target] < contrastRank[state.brand_guardrails.accessibility.contrast_target]) {
    throw Object.assign(new Error("Design tokens cannot fall below the Brand Guardrails accessibility requirements."), { code: "DESIGN_GUARDRAIL_BLOCKED", guardrail: "accessibility" });
  }
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > DESIGN_STATE_MAX_BYTES) throw Object.assign(new Error("This application's Design State exceeds the safe app setup-data limit. Reduce managed component count or text size before saving."), { code: "DESIGN_STATE_TOO_LARGE", status: 413 });
  return state;
}

function validateBrandGuardrails(guardrails) {
  for (const key of ["allowed_colors", "prohibited_colors"]) {
    if (!Array.isArray(guardrails[key]) || guardrails[key].length > 32) throw Object.assign(new Error(`Brand Guardrails ${key} must be a bounded list.`), { code: "DESIGN_STATE_INVALID" });
    for (const color of guardrails[key]) cssColor(color, `brand_guardrails.${key}`);
  }
  if (!Array.isArray(guardrails.allowed_logos) || guardrails.allowed_logos.length > 20 || guardrails.allowed_logos.some(item => typeof item !== "string" || item.length > 256 || item.startsWith("/") || item.includes(".."))) throw Object.assign(new Error("Allowed logos must be safe repository-relative asset references."), { code: "DESIGN_STATE_INVALID" });
  for (const fontsKey of ["allowed_heading_fonts", "allowed_body_fonts"]) {
    const fonts = guardrails.typography_rules?.[fontsKey];
    if (!Array.isArray(fonts) || fonts.some(font => !FONT_STACKS.includes(font))) throw Object.assign(new Error("Brand typography rules contain an unsupported font stack."), { code: "DESIGN_STATE_INVALID" });
  }
  if (!Array.isArray(guardrails.spacing_rules?.allowed_density) || guardrails.spacing_rules.allowed_density.some(item => !["compact", "comfortable", "spacious"].includes(item))) throw Object.assign(new Error("Brand spacing rules are invalid."), { code: "DESIGN_STATE_INVALID" });
  if (!Array.isArray(guardrails.component_rules?.allowed_types) || guardrails.component_rules.allowed_types.some(item => !DESIGN_COMPONENT_TYPES.includes(item))) throw Object.assign(new Error("Brand component rules are invalid."), { code: "DESIGN_STATE_INVALID" });
  if (!guardrails.accessibility || guardrails.accessibility.visible_focus !== true || !["AA", "AAA"].includes(guardrails.accessibility.contrast_target) || !isSafeMinimumTarget(guardrails.accessibility.minimum_target)) throw Object.assign(new Error("Accessibility brand rules are invalid."), { code: "DESIGN_STATE_INVALID" });
  if (!guardrails.locked_values || typeof guardrails.locked_values !== "object" || Array.isArray(guardrails.locked_values) || Object.keys(guardrails.locked_values).length > 64) throw Object.assign(new Error("Locked brand values are invalid."), { code: "DESIGN_STATE_INVALID" });
  for (const [pathName, value] of Object.entries(guardrails.locked_values)) {
    if (/^tokens\.colors\.(?:primary|secondary|accent|surface|background|text|muted|border)$/.test(pathName)) cssColor(value, `brand_guardrails.locked_values.${pathName}`);
    else if (/^tokens\.typography\.(?:heading|body)$/.test(pathName) && !FONT_STACKS.includes(value)) throw Object.assign(new Error(`Locked typography value ${pathName} is unsupported.`), { code: "DESIGN_STATE_INVALID" });
    else if (pathName === "tokens.spacing.density" && !["compact", "comfortable", "spacious"].includes(value)) throw Object.assign(new Error("Locked spacing density is unsupported."), { code: "DESIGN_STATE_INVALID" });
    else throw Object.assign(new Error(`Locked design path ${pathName} is unsupported.`), { code: "DESIGN_STATE_INVALID" });
  }
}

function isSafeMinimumTarget(value) {
  return typeof value === "string" && /^(?:44|48|56)px$/.test(value);
}

function markCanvasChanged(state, componentIds = []) {
  state.revision += 1;
  state.sync.status = "CANVAS_CHANGED";
  state.sync.updated_at = new Date().toISOString();
  for (const component of state.components) {
    if (component.ownership_state === "FELTUS_MANAGED" && (!componentIds.length || componentIds.includes(component.id))) component.sync_state = "CANVAS_CHANGED";
  }
  return validateDesignState(state);
}

function guardrailForChange(state, pathName, value) {
  const guardrails = state.brand_guardrails;
  const locked = guardrails.locked_values || {};
  if (Object.hasOwn(locked, pathName) && locked[pathName] !== value) {
    throw Object.assign(new Error(`This value is locked by the brand guardrail: ${pathName}.`), { code: "DESIGN_GUARDRAIL_BLOCKED", guardrail: "locked_values", path: pathName });
  }
  if (/^tokens\.colors\./.test(pathName)) {
    const color = cssColor(value, pathName);
    const allowed = guardrails.allowed_colors || [];
    if (allowed.length && !allowed.map(item => String(item).toLowerCase()).includes(color)) {
      throw Object.assign(new Error(`The color ${color} is outside the brand-approved palette.`), { code: "DESIGN_GUARDRAIL_BLOCKED", guardrail: "allowed_colors", path: pathName });
    }
    if ((guardrails.prohibited_colors || []).some(item => String(item).toLowerCase() === color)) {
      throw Object.assign(new Error(`The color ${color} is prohibited by the brand guardrail.`), { code: "DESIGN_GUARDRAIL_BLOCKED", guardrail: "prohibited_colors", path: pathName });
    }
  }
}

function setPath(target, pathName, value) {
  const parts = pathName.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== "object") current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

export function selectDesignRecipe(currentState, recipeId) {
  const recipe = DESIGN_RECIPES.find(item => item.id === recipeId);
  if (!recipe) throw Object.assign(new Error("Choose a recipe from the FELTUS Design Recipe catalog."), { code: "DESIGN_RECIPE_NOT_FOUND" });
  const next = clone(validateDesignState(currentState));
  const allowedColors = next.brand_guardrails.allowed_colors || [];
  for (const [key, value] of Object.entries(recipe.tokens.colors)) {
    if (allowedColors.length && !allowedColors.map(item => item.toLowerCase()).includes(value.toLowerCase()) || (next.brand_guardrails.prohibited_colors || []).some(item => item.toLowerCase() === value.toLowerCase())) {
      throw Object.assign(new Error(`Recipe ${recipe.name} uses ${key} color ${value}, which conflicts with Brand Guardrails.`), { code: "DESIGN_GUARDRAIL_BLOCKED", guardrail: "allowed_colors", path: `tokens.colors.${key}` });
    }
  }
  if (next.brand_guardrails.spacing_rules?.allowed_density?.length && !next.brand_guardrails.spacing_rules.allowed_density.includes(recipe.tokens.spacing.density)) throw Object.assign(new Error(`Recipe ${recipe.name} uses a density blocked by Brand Guardrails.`), { code: "DESIGN_GUARDRAIL_BLOCKED", guardrail: "spacing_rules" });
  if (next.brand_guardrails.typography_rules?.allowed_heading_fonts?.length && !next.brand_guardrails.typography_rules.allowed_heading_fonts.includes(recipe.tokens.typography.heading)) throw Object.assign(new Error(`Recipe ${recipe.name} uses a heading font blocked by Brand Guardrails.`), { code: "DESIGN_GUARDRAIL_BLOCKED", guardrail: "typography_rules" });
  if (next.brand_guardrails.typography_rules?.allowed_body_fonts?.length && !next.brand_guardrails.typography_rules.allowed_body_fonts.includes(recipe.tokens.typography.body)) throw Object.assign(new Error(`Recipe ${recipe.name} uses a body font blocked by Brand Guardrails.`), { code: "DESIGN_GUARDRAIL_BLOCKED", guardrail: "typography_rules" });
  for (const [key, value] of Object.entries(recipe.tokens)) {
    for (const [property, tokenValue] of Object.entries(value || {})) {
      const pathName = `tokens.${key}.${property}`;
      if (Object.hasOwn(next.brand_guardrails.locked_values || {}, pathName) && next.brand_guardrails.locked_values[pathName] !== tokenValue) throw Object.assign(new Error(`Recipe ${recipe.name} conflicts with the locked brand value ${pathName}.`), { code: "DESIGN_GUARDRAIL_BLOCKED", guardrail: "locked_values", path: pathName });
    }
  }
  next.active_recipe_id = recipe.id;
  next.profile = { id: recipe.id, name: recipe.name, kind: "recipe", base_recipe_ids: [recipe.id] };
  next.tokens = clone(recipe.tokens);
  if (Number.parseInt(next.brand_guardrails.accessibility.minimum_target, 10) > Number.parseInt(next.tokens.accessibility.minimum_target, 10)) {
    next.tokens.accessibility.minimum_target = next.brand_guardrails.accessibility.minimum_target;
  }
  if (next.brand_guardrails.accessibility.contrast_target === "AAA") next.tokens.accessibility.contrast_target = "AAA";
  next.global_styles = { max_content_width: recipe.tokens.layout.content_width, page_background: recipe.tokens.colors.background };
  next.responsive = clone(recipe.responsive);
  return markCanvasChanged(next);
}

function validateComponentProperty(component, property, value) {
  const supported = new Set(["alignment", "layout", "width", "padding", "gap", "visible", "background", "color", "radius", "shadow", "font_size", "variant", "content"]);
  if (!supported.has(property)) throw Object.assign(new Error(`Unsupported visual property: ${property}.`), { code: "DESIGN_PROPERTY_UNSUPPORTED" });
  if (property === "alignment" && !["start", "center", "end", "stretch"].includes(value)) throw Object.assign(new Error("Unsupported alignment."), { code: "DESIGN_VALUE_INVALID" });
  if (property === "layout" && !["stack", "row", "grid", "split", "overlay"].includes(value)) throw Object.assign(new Error("Unsupported component layout."), { code: "DESIGN_VALUE_INVALID" });
  if (property === "width" && !["full", "wide", "medium", "narrow", "auto"].includes(value)) throw Object.assign(new Error("Unsupported component width."), { code: "DESIGN_VALUE_INVALID" });
  if (["padding", "gap", "font_size"].includes(property) && !/^(?:0|[2-9]|1[0-6]|2[0-4]|3[2-6]|40|48|64)px$/.test(String(value))) throw Object.assign(new Error(`Unsupported ${property} value.`), { code: "DESIGN_VALUE_INVALID" });
  if (property === "visible" && typeof value !== "boolean") throw Object.assign(new Error("Visibility must be a boolean."), { code: "DESIGN_VALUE_INVALID" });
  if (["background", "color"].includes(property) && !["surface", "background", "primary", "secondary", "accent", "text", "muted", "transparent"].includes(value)) cssColor(value, property);
  if (property === "radius" && !["small", "medium", "large", "pill"].includes(value)) throw Object.assign(new Error("Unsupported component radius."), { code: "DESIGN_VALUE_INVALID" });
  if (property === "shadow" && !["none", "small", "medium", "large"].includes(value)) throw Object.assign(new Error("Unsupported component shadow."), { code: "DESIGN_VALUE_INVALID" });
  if (property === "variant" && !VARIANTS[component.type]?.includes(value)) throw Object.assign(new Error(`Variant ${value} is not supported for ${component.type}.`), { code: "DESIGN_VALUE_INVALID" });
  if (property === "content" && (typeof value !== "string" || value.length > 300 || /[<>]/.test(value))) throw Object.assign(new Error("Component text must be plain text up to 300 characters."), { code: "DESIGN_VALUE_INVALID" });
}

export function customizeDesignState(currentState, updates = {}) {
  const next = clone(validateDesignState(currentState));
  const changes = updates.changes || [];
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 32) throw Object.assign(new Error("A design edit must contain between 1 and 32 bounded property changes."), { code: "DESIGN_PROPOSAL_INVALID" });
  const touched = new Set();
  const affected = [];
  for (const change of changes) {
    if (change.target === "token") {
      const pathName = `tokens.${change.key}`;
      const tokenFields = {
        colors: ["primary", "secondary", "accent", "surface", "background", "text", "muted", "border"],
        typography: ["heading", "body", "base_size", "line_height", "weight"],
        spacing: ["unit", "density", "page", "section", "component"],
        radii: ["small", "medium", "large", "pill"],
        shadows: ["small", "medium", "large"],
        layout: ["content_width", "columns", "navigation", "density"],
        motion: ["duration", "reduced_motion"],
        accessibility: ["visible_focus", "minimum_target", "contrast_target"]
      };
      const [, group, field] = /^tokens\.([a-z_]+)\.([a-z_]+)$/.exec(pathName) || [];
      if (!tokenFields[group]?.includes(field)) throw Object.assign(new Error("The requested design token is not editable."), { code: "DESIGN_PROPERTY_UNSUPPORTED" });
      guardrailForChange(next, pathName, change.value);
      if (pathName.startsWith("tokens.colors.")) cssColor(change.value, pathName);
      if (pathName === "tokens.typography.heading" || pathName === "tokens.typography.body") {
        if (!FONT_STACKS.includes(change.value)) throw Object.assign(new Error("Choose an available typeface."), { code: "DESIGN_VALUE_INVALID" });
      }
      if (pathName === "tokens.spacing.density" && !(next.brand_guardrails.spacing_rules?.allowed_density || []).includes(change.value)) throw Object.assign(new Error("That density is outside the brand spacing rules."), { code: "DESIGN_GUARDRAIL_BLOCKED", guardrail: "spacing_rules" });
      if (pathName === "tokens.typography.heading" && next.brand_guardrails.typography_rules?.allowed_heading_fonts?.length && !next.brand_guardrails.typography_rules.allowed_heading_fonts.includes(change.value)) throw Object.assign(new Error("That heading font is outside the brand typography rules."), { code: "DESIGN_GUARDRAIL_BLOCKED", guardrail: "typography_rules" });
      if (pathName === "tokens.typography.body" && next.brand_guardrails.typography_rules?.allowed_body_fonts?.length && !next.brand_guardrails.typography_rules.allowed_body_fonts.includes(change.value)) throw Object.assign(new Error("That body font is outside the brand typography rules."), { code: "DESIGN_GUARDRAIL_BLOCKED", guardrail: "typography_rules" });
      setPath(next, pathName, change.value);
      touched.add(pathName);
      continue;
    }
    if (change.target !== "component") throw Object.assign(new Error("Design changes must target a supported token or component."), { code: "DESIGN_PROPOSAL_INVALID" });
    const component = next.components.find(item => item.id === change.component_id);
    if (!component) throw Object.assign(new Error(`Component ${change.component_id} was not found.`), { code: "DESIGN_COMPONENT_NOT_FOUND" });
    if (component.ownership_state !== "FELTUS_MANAGED") throw Object.assign(new Error(`Component ${component.id} is Developer Managed. Reconnect visual editing before changing it.`), { code: "DESIGN_COMPONENT_DEVELOPER_MANAGED" });
    if (!(next.brand_guardrails.component_rules?.allowed_types || DESIGN_COMPONENT_TYPES).includes(component.type)) throw Object.assign(new Error(`${component.type} is outside the brand component rules.`), { code: "DESIGN_GUARDRAIL_BLOCKED", guardrail: "component_rules" });
    validateComponentProperty(component, change.property, change.value);
    if (change.property === "content" && component.content === null) throw Object.assign(new Error("This component has structured content. Its text cannot be edited through the bounded visual contract."), { code: "DESIGN_CONTENT_UNSUPPORTED" });
    const responsiveTarget = change.responsive_target || "desktop";
    if (!["desktop", "tablet", "mobile"].includes(responsiveTarget)) throw Object.assign(new Error("Choose Desktop, Tablet, or Mobile."), { code: "DESIGN_RESPONSIVE_TARGET_INVALID" });
    const targetPath = change.property === "variant" ? `components.${component.id}.variant` : `components.${component.id}.${responsiveTarget}.${change.property}`;
    guardrailForChange(next, targetPath, change.value);
    if (change.property === "variant") component.variant = change.value;
    else if (change.property === "content") component.content = change.value;
    else {
      component.responsive[responsiveTarget] ||= {};
      component.responsive[responsiveTarget][change.property] = change.value;
    }
    touched.add(targetPath);
    if (!affected.includes(component.id)) affected.push(component.id);
  }
  next.profile = { id: `custom-${designStateHash({ tokens: next.tokens, responsive: next.responsive, components: next.components }).slice(0, 16)}`, name: "Custom Design Profile", kind: "custom", base_recipe_ids: [...new Set([...(next.profile.base_recipe_ids || []), next.active_recipe_id])] };
  next.sync.changed_paths = [...touched].sort();
  return markCanvasChanged(next, affected);
}

export function createDesignVariation(currentState, variation) {
  const variations = {
    Conservative: [{ target: "token", key: "colors.primary", value: currentState.tokens.colors.secondary }, { target: "token", key: "spacing.density", value: "comfortable" }],
    Premium: [{ target: "token", key: "colors.primary", value: "#263b58" }, { target: "token", key: "radii.large", value: "24px" }, { target: "token", key: "shadows.large", value: "0 18px 40px #070b142e" }],
    Bold: [{ target: "token", key: "colors.accent", value: "#e55d3d" }, { target: "token", key: "typography.weight", value: 700 }]
  };
  if (!Object.hasOwn(variations, variation)) throw Object.assign(new Error("Choose Conservative, Premium, or Bold."), { code: "DESIGN_VARIATION_INVALID" });
  const next = customizeDesignState(currentState, { changes: variations[variation] });
  next.profile.name = `${variation} · ${next.profile.name}`;
  return validateDesignState(next);
}

export function setDesignGuardrails(currentState, brandGuardrails) {
  const next = clone(validateDesignState(currentState));
  if (!brandGuardrails || typeof brandGuardrails !== "object" || Array.isArray(brandGuardrails)) throw Object.assign(new Error("Provide structured brand guardrails."), { code: "DESIGN_STATE_INVALID" });
  const candidate = { ...clone(DEFAULT_BRAND_GUARDRAILS), ...clone(brandGuardrails) };
  candidate.typography_rules = { ...clone(DEFAULT_BRAND_GUARDRAILS.typography_rules), ...(brandGuardrails.typography_rules || {}) };
  candidate.spacing_rules = { ...clone(DEFAULT_BRAND_GUARDRAILS.spacing_rules), ...(brandGuardrails.spacing_rules || {}) };
  candidate.component_rules = { ...clone(DEFAULT_BRAND_GUARDRAILS.component_rules), ...(brandGuardrails.component_rules || {}) };
  candidate.accessibility = { ...clone(DEFAULT_BRAND_GUARDRAILS.accessibility), ...(brandGuardrails.accessibility || {}) };
  candidate.locked_values = clone(brandGuardrails.locked_values || {});
  validateBrandGuardrails(candidate);
  next.brand_guardrails = candidate;
  if (Number.parseInt(candidate.accessibility.minimum_target, 10) > Number.parseInt(next.tokens.accessibility.minimum_target, 10)) {
    next.tokens.accessibility.minimum_target = candidate.accessibility.minimum_target;
  }
  if (candidate.accessibility.contrast_target === "AAA") next.tokens.accessibility.contrast_target = "AAA";
  return markCanvasChanged(next);
}

export function componentSyncSummary(state) {
  const validState = validateDesignState(state);
  const counts = { synchronized: 0, developer_managed: 0, reconciliation_required: 0, reconciliation_available: 0, stylesheet_reconciliation_required: 0 };
  if ((validState.sync.last_reconciliation || []).some(item => item.component_id === null && item.outcome === "RECONCILIATION_REQUIRED")) counts.stylesheet_reconciliation_required = 1;
  for (const component of validState.components) {
    if (component.ownership_state === "DEVELOPER_MANAGED") counts.developer_managed += 1;
    else counts.synchronized += component.sync_state === "SYNCED" ? 1 : 0;
    if (component.reconciliation_state === "REQUIRED") counts.reconciliation_required += 1;
    if (component.reconciliation_state === "AVAILABLE") counts.reconciliation_available += 1;
  }
  return counts;
}

export function reconcileDesignSource(currentState, files, sourceIdentity = {}, { allowManagedStylesheetUpdate = false } = {}) {
  const state = clone(validateDesignState(currentState));
  const current = new Map(discoverDesignComponents(files).map(item => [item.id, item]));
  const decisions = [];
  const stylesheet = files.find(file => file.path === "src/feltus-design.css");
  if (stylesheet) {
    const stylesheetHash = stylesheet.sha256 || sha256(stylesheet.content);
    const baselineHash = state.sync.source_stylesheet_sha256 || null;
    const generatedStylesheet = stylesheet.content.startsWith("/* FELTUS-DESIGN-MANAGED-V1:");
    if (allowManagedStylesheetUpdate && generatedStylesheet && stylesheet.content === generateManagedDesignCss(state)) state.sync.source_stylesheet_sha256 = stylesheetHash;
    else if (!baselineHash && generatedStylesheet && stylesheet.content === generateManagedDesignCss(state)) state.sync.source_stylesheet_sha256 = stylesheetHash;
    else if (baselineHash !== stylesheetHash) {
      decisions.push({ component_id: null, outcome: "RECONCILIATION_REQUIRED", reason: "The shared managed Design Studio stylesheet changed outside a reviewed Design Studio change set. Restore or review the developer stylesheet before applying visual edits." });
    }
  }
  for (const component of state.components) {
    const source = current.get(component.id);
    const old = component.source_contract || {};
    if (!source) {
      if (old.source_sha256) {
        component.ownership_state = "DEVELOPER_MANAGED";
        component.reconciliation_state = "REQUIRED";
        component.sync_state = "RECONCILIATION_REQUIRED";
        component.source_contract = { ...old, source_sha256: null, managed: false };
        decisions.push({ component_id: component.id, outcome: "RECONCILIATION_REQUIRED", reason: "Managed component identity is absent from current source." });
      }
      continue;
    }
    if (source.source_sha256 === old.source_sha256) {
      current.delete(component.id);
      continue;
    }
    if (component.ownership_state === "DEVELOPER_MANAGED") {
      component.source_contract = { tag: source.tag, type: source.type, variant: source.variant, content_sha256: source.content_sha256, source_sha256: source.source_sha256, managed: source.managed };
      component.sync_state = "SYNCED";
      decisions.push({ component_id: component.id, outcome: "DEVELOPER_VERSION_PRESERVED", reason: "This component remains developer-owned; source content was retained." });
      current.delete(component.id);
      continue;
    }
    const supportedExternalEdit = source.type === old.type && source.tag === old.tag && old.managed === true;
    const reviewedReconnect = source.type === component.type && source.tag === component.tag;
    const stableShape = source.managed && (supportedExternalEdit || reviewedReconnect) &&
      VARIANTS[source.type]?.includes(source.variant) &&
      (source.content_sha256 === old.content_sha256 || source.content !== null && source.content.length <= 300);
    if (stableShape) {
      component.variant = source.variant;
      if (source.content !== null && source.content.length <= 300) component.content = source.content;
      component.source_contract = { tag: source.tag, type: source.type, variant: source.variant, content_sha256: source.content_sha256, source_sha256: source.source_sha256, managed: source.managed };
      component.ownership_state = "FELTUS_MANAGED";
      component.reconciliation_state = "AVAILABLE";
      component.sync_state = "SYNCED";
      decisions.push({ component_id: component.id, outcome: "AUTOMATIC_RECONCILIATION", transition: "CODE_CHANGED → SYNCED", reason: "Supported component variant change mapped deterministically." });
    } else {
      component.ownership_state = "DEVELOPER_MANAGED";
      component.reconciliation_state = "REQUIRED";
      component.sync_state = "RECONCILIATION_REQUIRED";
      component.source_contract = { tag: source.tag, type: source.type, variant: source.variant, content_sha256: source.content_sha256, source_sha256: source.source_sha256, managed: source.managed };
      decisions.push({ component_id: component.id, outcome: "RECONCILIATION_REQUIRED", reason: "Source structure changed beyond the deterministic managed-component contract." });
    }
    current.delete(component.id);
  }
  for (const source of current.values()) {
    const component = componentRecord(source, "DEVELOPER_MANAGED");
    component.ownership_state = "DEVELOPER_MANAGED";
    component.reconciliation_state = "REQUIRED";
    component.sync_state = "RECONCILIATION_REQUIRED";
    state.components.push(component);
    decisions.push({ component_id: source.id, outcome: "RECONCILIATION_REQUIRED", reason: "A new source component requires an explicit ownership decision." });
  }
  state.pages = pagesFromComponents(state.components);
  state.sync = {
    ...state.sync,
    status: decisions.some(item => item.outcome === "RECONCILIATION_REQUIRED") ? "RECONCILIATION_REQUIRED" : "SYNCED",
    source_checkpoint: sourceIdentity.commit || state.sync.source_checkpoint || null,
    source_snapshot_sha256: sourceIdentity.snapshot_sha256 || state.sync.source_snapshot_sha256 || null,
    source_branch: sourceIdentity.branch || state.sync.source_branch || null,
    source_workspace_id: sourceIdentity.workspace_id || state.sync.source_workspace_id || null,
    classifier_version: sourceIdentity.classifier_version || state.sync.classifier_version || null,
    source_clean: sourceIdentity.clean !== false,
    updated_at: new Date().toISOString(),
    last_reconciliation: decisions
  };
  return { state: validateDesignState(state), decisions, summary: componentSyncSummary(state) };
}

export function setComponentOwnership(currentState, componentId, ownership) {
  if (!["FELTUS_MANAGED", "DEVELOPER_MANAGED"].includes(ownership)) throw Object.assign(new Error("Choose a supported component ownership state."), { code: "DESIGN_OWNERSHIP_INVALID" });
  const state = clone(validateDesignState(currentState));
  const component = state.components.find(item => item.id === componentId);
  if (!component) throw Object.assign(new Error(`Component ${componentId} was not found.`), { code: "DESIGN_COMPONENT_NOT_FOUND" });
  component.ownership_state = ownership;
  component.reconciliation_state = ownership === "FELTUS_MANAGED" ? "AVAILABLE" : "NOT_REQUIRED";
  component.sync_state = ownership === "FELTUS_MANAGED" ? "SYNCED" : "SYNCED";
  return markCanvasChanged(state, [componentId]);
}

export function prepareDesignProposal({ currentState, actions = [], files = [], applicationId = null, sourceIdentity = {} } = {}) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 16) {
    throw Object.assign(new Error("A Design Studio proposal must contain between 1 and 16 bounded actions."), { code: "DESIGN_PROPOSAL_INVALID" });
  }
  const beforeState = validateDesignState(currentState);
  let next = clone(beforeState);
  for (const action of actions) {
    if (action.type === "select_recipe") next = selectDesignRecipe(next, action.recipe_id);
    else if (action.type === "edit") next = customizeDesignState(next, { changes: action.changes });
    else if (action.type === "variation") next = createDesignVariation(next, action.variation);
    else if (action.type === "ownership") next = setComponentOwnership(next, action.component_id, action.ownership_state);
    else if (action.type === "guardrails") next = setDesignGuardrails(next, action.value);
    else throw Object.assign(new Error(`Unsupported Design Studio action: ${action.type}.`), { code: "DESIGN_ACTION_UNSUPPORTED" });
  }
  const proposal = {
    contract: DESIGN_PROPOSAL_CONTRACT,
    id: crypto.randomUUID(),
    base_state_hash: designStateHash(beforeState),
    after_state_hash: designStateHash(next),
    application_id: applicationId,
    source_identity: {
      application_id: applicationId,
      checkpoint: sourceIdentity.commit || null,
      workspace_id: sourceIdentity.workspace_id || null,
      snapshot_sha256: sourceIdentity.snapshot_sha256 || null,
      classifier_version: sourceIdentity.classifier_version || null,
      branch: sourceIdentity.branch || null
    },
    scope: { component_ids: [...new Set(actions.flatMap(action => action.changes?.map(change => change.component_id).filter(Boolean) || [action.component_id].filter(Boolean)))], page_ids: [...new Set(actions.flatMap(action => action.changes?.map(change => change.page_id).filter(Boolean) || []))] },
    actions: clone(actions),
    after_state: next,
    preview_css: generateManagedDesignCss(next),
    change_set: buildDesignChangeSet({ designState: next, beforeState, files, applicationId, sourceIdentity })
  };
  return proposal;
}

function cssValue(value, property) {
  if (typeof value !== "string") return value;
  if (["surface", "background", "primary", "secondary", "accent", "text", "muted"].includes(value)) return `var(--feltus-color-${value})`;
  if (property === "radius") return `var(--feltus-radius-${value})`;
  if (property === "shadow") return value === "none" ? "none" : `var(--feltus-shadow-${value})`;
  return value;
}

function componentCss(component, responsiveTarget = "desktop") {
  const values = { ...COMPONENT_DEFAULTS, ...component.properties, ...(component.responsive?.[responsiveTarget] || {}) };
  const declarations = [];
  const type = component.type;
  const layouts = { row: "flex", stack: "flex", grid: "grid", split: "grid", overlay: "grid" };
  declarations.push("box-sizing: border-box;");
  declarations.push(`display: ${values.visible === false ? "none" : layouts[values.layout] || (type === "button" ? "inline-flex" : "block")};`);
  if (["row", "stack"].includes(values.layout)) declarations.push(`flex-direction: ${values.layout === "row" ? "row" : "column"};`);
  if (["grid", "split"].includes(values.layout)) declarations.push(`grid-template-columns: ${values.layout === "split" ? "repeat(2, minmax(0, 1fr))" : "repeat(var(--feltus-grid-columns, 12), minmax(0, 1fr))"};`);
  if (type === "navigation") declarations.push("align-items: center; flex-wrap: wrap;");
  if (type === "card" || type === "hero" || type === "dashboard-region" || type === "modal") declarations.push(`background: ${cssValue(values.background || "surface", "background")}; color: ${cssValue(values.color || "text", "color")};`);
  if (type === "button") declarations.push(`background: ${cssValue(values.background || "primary", "background")}; color: ${cssValue(values.color || "surface", "color")}; border: 0; align-items: center; justify-content: center; min-height: var(--feltus-minimum-target, 44px);`);
  if (type === "card") declarations.push("border: 1px solid var(--feltus-color-border);");
  declarations.push(`text-align: ${values.alignment === "center" ? "center" : values.alignment === "end" ? "right" : values.alignment === "stretch" ? "justify" : "left"};`);
  const width = values.width === "full" && type === "button" ? "auto" : values.width;
  const padding = values.padding || "var(--feltus-space-component)";
  const gap = values.gap || "var(--feltus-space-gap, var(--feltus-space-component))";
  declarations.push(`width: ${({ full: "100%", wide: "min(100%, 1200px)", medium: "min(100%, 800px)", narrow: "min(100%, 560px)", auto: "auto" })[width] || "auto"};`);
  declarations.push(`padding: ${padding}; gap: ${gap}; border-radius: ${cssValue(values.radius || "medium", "radius")}; box-shadow: ${cssValue(values.shadow || "small", "shadow")};`);
  declarations.push(`font-size: ${values.font_size};`);
  if (component.content !== null && component.content !== undefined) declarations.push("--feltus-component-content-managed: 1;");
  const selector = `[data-feltus-id="${component.id}"]`;
  const rules = [`${selector} {\n  ${declarations.join("\n  ")}\n}`];
  const variantRules = {
    hero: { centered: "justify-items: center; text-align: center;", split: "grid-template-columns: repeat(2, minmax(0, 1fr));", compact: "padding-block: 16px;" },
    navigation: { centered: "justify-content: center;", compact: "gap: 8px;", sidebar: "flex-direction: column; align-items: stretch;" },
    card: { flat: "box-shadow: none; border-color: transparent;", outlined: "box-shadow: none; background: transparent;", compact: "padding: 12px;" },
    form: { inline: "display: flex; align-items: end; flex-wrap: wrap;", compact: "gap: 8px;" },
    table: { compact: "font-size: 14px;", striped: "border-collapse: separate; border-spacing: 0 4px;" },
    section: { compact: "padding-block: 16px;", spacious: "padding-block: 40px;" },
    button: { secondary: "background: var(--feltus-color-secondary);", outline: "background: transparent; color: var(--feltus-color-primary); border: 1px solid currentColor;", quiet: "background: transparent; color: var(--feltus-color-text);" },
    sidebar: { compact: "gap: 8px;", rail: "width: 72px;" },
    header: { compact: "padding-block: 8px;", centered: "justify-content: center;" },
    "dashboard-region": { compact: "gap: 12px;", wide: "grid-column: 1 / -1;" },
    media: { contained: "object-fit: contain;", cover: "object-fit: cover;" },
    footer: { compact: "padding-block: 12px;", columns: "display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));" },
    modal: { compact: "padding: 16px;", wide: "width: min(100%, 900px);" },
    page: { wide: "max-width: 1400px;", reading: "max-width: 720px;" }
  }[type] || {};
  for (const [variant, declarationsForVariant] of Object.entries(variantRules)) {
    rules.push(`${selector}[data-feltus-variant="${variant}"] { ${declarationsForVariant} }`);
  }
  return rules.join("\n");
}

export function generateManagedDesignCss(input) {
  const state = validateDesignState(input);
  const tokens = state.tokens;
  const root = [
    `--feltus-color-primary: ${tokens.colors.primary};`, `--feltus-color-secondary: ${tokens.colors.secondary};`,
    `--feltus-color-accent: ${tokens.colors.accent};`, `--feltus-color-surface: ${tokens.colors.surface};`,
    `--feltus-color-background: ${tokens.colors.background};`, `--feltus-color-text: ${tokens.colors.text};`,
    `--feltus-color-muted: ${tokens.colors.muted};`, `--feltus-color-border: ${tokens.colors.border};`,
    `--feltus-font-heading: ${tokens.typography.heading};`, `--feltus-font-body: ${tokens.typography.body};`,
    `--feltus-font-size: ${tokens.typography.base_size};`, `--feltus-line-height: ${tokens.typography.line_height};`,
    `--feltus-radius-small: ${tokens.radii.small};`, `--feltus-radius-medium: ${tokens.radii.medium};`,
    `--feltus-radius-large: ${tokens.radii.large};`, `--feltus-radius-pill: ${tokens.radii.pill};`,
    `--feltus-shadow-small: ${tokens.shadows.small};`, `--feltus-shadow-medium: ${tokens.shadows.medium};`,
    `--feltus-shadow-large: ${tokens.shadows.large};`, `--feltus-content-width: ${tokens.layout.content_width};`,
    `--feltus-space-unit: ${tokens.spacing.unit};`, `--feltus-space-page: ${tokens.spacing.page};`,
    `--feltus-space-section: ${tokens.spacing.section};`, `--feltus-space-component: ${tokens.spacing.component};`,
    `--feltus-minimum-target: ${state.brand_guardrails.accessibility.minimum_target};`
  ].join("\n  ");
  const managed = state.components.filter(component => component.ownership_state === "FELTUS_MANAGED");
  const profileFingerprint = sha256(JSON.stringify(sorted({ active_recipe_id: state.active_recipe_id, profile: state.profile, tokens: state.tokens, global_styles: state.global_styles, responsive: state.responsive, brand_guardrails: state.brand_guardrails })));
  const parts = [`/* FELTUS-DESIGN-MANAGED-V1: generated by Design Studio; profile ${profileFingerprint}; edit through FELTUS CODE. */`, `:root {\n  ${root}\n}`, "[data-feltus-design-root] { max-width: var(--feltus-content-width); margin-inline: auto; padding-inline: var(--feltus-space-page); color: var(--feltus-color-text); background: var(--feltus-color-background); font-family: var(--feltus-font-body); font-size: var(--feltus-font-size); line-height: var(--feltus-line-height); }", `[data-feltus-design-root] h1, [data-feltus-design-root] h2, [data-feltus-design-root] h3 { font-family: var(--feltus-font-heading); font-weight: ${tokens.typography.weight}; }`, "[data-feltus-design-root] [data-feltus-component=section] { padding-block: var(--feltus-space-section); }", ...managed.map(component => componentCss(component))];
  for (const viewport of ["tablet", "mobile"]) {
    const maxWidth = viewport === "tablet" ? DESIGN_BREAKPOINTS.desktop : DESIGN_BREAKPOINTS.tablet;
    const rules = managed.map(component => componentCss(component, viewport)).join("\n\n");
    const viewportRules = `[data-feltus-design-root] { --feltus-grid-columns: ${state.responsive[viewport].columns}; --feltus-space-page: ${state.responsive[viewport].page_padding}; --feltus-space-gap: ${state.responsive[viewport].gap}; }`;
    parts.push(`@media (max-width: ${maxWidth}px) {\n  ${viewportRules}\n  ${rules.replace(/\n/g, "\n  ")}\n}`);
  }
  parts.push("@media (prefers-reduced-motion: reduce) { [data-feltus-design-root], [data-feltus-design-root] * { scroll-behavior: auto !important; animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }");
  return `${parts.join("\n\n")}\n`;
}

function findHtml(files, preferred = null) {
  return files.find(file => file.path === preferred) || files.find(file => /^(?:index\.html|src\/index\.html|public\/index\.html)$/i.test(file.path)) || files.find(file => /\.html?$/i.test(file.path));
}

function stylesheetHref(htmlPath, cssPath) {
  const relative = path.posix.relative(path.posix.dirname(htmlPath), cssPath);
  return `./${relative.startsWith(".") ? relative : relative}`;
}

export function attachManagedStylesheet(html, htmlPath, cssPath = "src/feltus-design.css") {
  const existing = /<link\b[^>]*data-feltus-design-stylesheet=["']v1["'][^>]*>/i.exec(html);
  const href = stylesheetHref(htmlPath, cssPath);
  if (existing) {
    if (new RegExp(`href=["']${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "i").test(existing[0])) return html;
    throw Object.assign(new Error("The managed Design Studio stylesheet link was changed outside its supported contract."), { code: "DESIGN_STYLESHEET_CONFLICT" });
  }
  const tag = `<link rel="stylesheet" href="${href}" data-feltus-design-stylesheet="v1">`;
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, `  ${tag}\n</head>`);
  if (/<body\b/i.test(html)) return html.replace(/<body\b/i, `${tag}\n<body`);
  return `${tag}\n${html}`;
}

function updateManagedOpening(fileContent, source, component) {
  let opening = fileContent.slice(source.start, source.open_end);
  const marker = /\sdata-feltus-managed=["'][^"']*["']/i;
  const variant = /\sdata-feltus-variant=["'][^"']*["']/i;
  const type = /\sdata-feltus-component=["'][^"']*["']/i;
  if (component.ownership_state === "FELTUS_MANAGED") {
    if (marker.test(opening)) opening = opening.replace(marker, " data-feltus-managed=\"v1\"");
    else opening = opening.slice(0, -1) + " data-feltus-managed=\"v1\">";
    if (type.test(opening)) opening = opening.replace(type, ` data-feltus-component=\"${component.type}\"`);
    else opening = opening.slice(0, -1) + ` data-feltus-component=\"${component.type}\">`;
  } else {
    opening = opening.replace(marker, "");
  }
  if (component.ownership_state === "FELTUS_MANAGED") {
    if (variant.test(opening)) opening = opening.replace(variant, ` data-feltus-variant="${component.variant}"`);
    else opening = opening.slice(0, -1) + ` data-feltus-variant="${component.variant}">`;
  }
  return opening;
}

function addDesignRoot(html) {
  return html.replace(/<body\b([^>]*)>/i, (tag, attrs) => {
    if (/\bdata-feltus-design-root(?:\s|=|$)/i.test(attrs)) return tag;
    return `<body${attrs} data-feltus-design-root="v1">`;
  });
}

export function buildDesignChangeSet({ designState, files, applicationId = null, sourceIdentity = {}, beforeState = null } = {}) {
  const state = validateDesignState(designState);
  const htmlFile = findHtml(files);
  if (!htmlFile) throw Object.assign(new Error("Design Studio can edit only a repository with a supported HTML entry page."), { code: "DESIGN_SOURCE_UNSUPPORTED" });
  const cssPath = "src/feltus-design.css";
  const existingCss = files.find(file => file.path === cssPath);
  const stylesheetHash = existingCss?.sha256 || (existingCss ? sha256(existingCss.content) : null);
  const expectedStylesheetHash = beforeState?.sync?.source_stylesheet_sha256 || null;
  const stylesheetMatches = expectedStylesheetHash
    ? stylesheetHash === expectedStylesheetHash
    : existingCss?.content === generateManagedDesignCss(beforeState || state);
  if (existingCss && (!existingCss.content.startsWith("/* FELTUS-DESIGN-MANAGED-V1:") || !stylesheetMatches)) {
    throw Object.assign(new Error("The managed Design Studio stylesheet path already contains developer source."), { code: "DESIGN_STYLESHEET_CONFLICT" });
  }
  const operations = [];
  const htmlFiles = files.filter(file => /\.html?$/i.test(file.path));
  const sourceEditsByFile = new Map();
  const sourceComponents = discoverDesignComponents(files);
  for (const component of state.components) {
    const source = sourceComponents.find(item => item.id === component.id);
    if (!source) continue;
    const ownerIsManaged = component.ownership_state === "FELTUS_MANAGED";
    const textChanged = component.content !== null && component.content !== undefined && source.content !== component.content;
    if (ownerIsManaged !== source.managed || textChanged || ownerIsManaged && source.variant !== component.variant) {
      const edits = sourceEditsByFile.get(source.path) || [];
      edits.push({ source, component, update_opening: ownerIsManaged !== source.managed || ownerIsManaged && source.variant !== component.variant, update_text: textChanged });
      sourceEditsByFile.set(source.path, edits);
    }
  }
  const nextHtml = new Map(htmlFiles.map(file => [file.path, file.content]));
  const componentPages = new Set(sourceComponents.filter(item => state.components.some(component => component.id === item.id)).map(item => item.path));
  for (const filePath of new Set([...componentPages, htmlFile.path])) {
    const sourceFile = files.find(item => item.path === filePath);
    const edits = sourceEditsByFile.get(filePath) || [];
    const ranges = [];
    for (const edit of edits) {
      if (edit.update_opening) ranges.push({ start: edit.source.start, end: edit.source.open_end, content: updateManagedOpening(sourceFile.content, edit.source, edit.component) });
      if (edit.update_text) {
        if (edit.source.content === null) throw Object.assign(new Error(`Component ${edit.source.id} does not expose a plain-text content slot.`), { code: "DESIGN_CONTENT_UNSUPPORTED" });
        const escaped = edit.component.content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        ranges.push({ start: edit.source.open_end, end: edit.source.close_start, content: escaped });
      }
    }
    let content = sourceFile.content;
    for (const range of ranges.sort((a, b) => b.start - a.start)) content = content.slice(0, range.start) + range.content + content.slice(range.end);
    nextHtml.set(filePath, addDesignRoot(attachManagedStylesheet(content, filePath, cssPath)));
  }
  for (const [filePath, content] of nextHtml) {
    const sourceFile = htmlFiles.find(item => item.path === filePath);
    if (content !== sourceFile.content) operations.push({ id: `design-html-${sha256(filePath).slice(0, 10)}`, type: "update", path: filePath, content, before_sha256: sourceFile.sha256, reason: "Link the generated FELTUS managed design stylesheet and preserve the component contract.", agent: "code-agent" });
  }
  const css = generateManagedDesignCss(state);
  if (!existingCss) operations.push({ id: "design-managed-stylesheet", type: "create", path: cssPath, content: css, reason: "Create the generated FELTUS managed design stylesheet.", agent: "code-agent" });
  else if (existingCss.content !== css) operations.push({ id: "design-managed-stylesheet", type: "update", path: cssPath, content: css, before_sha256: existingCss.sha256, reason: "Update the generated FELTUS managed design stylesheet.", agent: "code-agent" });
  if (!operations.length) throw Object.assign(new Error("The proposed Design State produces no source change."), { code: "DESIGN_NO_SOURCE_CHANGE" });
  if (operations.length > 24) throw Object.assign(new Error("This visual change touches too many source files for one reviewed CODE change set."), { code: "DESIGN_CHANGE_SET_TOO_LARGE" });
  return {
    id: crypto.randomUUID(),
    summary: "Apply reviewed Design Studio changes to the managed visual contract",
    operations,
    feltus_design: {
      contract: "feltus.design-change/v1",
      application_id: applicationId,
      source_checkpoint: sourceIdentity.commit || null,
      source_snapshot_sha256: sourceIdentity.snapshot_sha256 || null,
      classifier_version: sourceIdentity.classifier_version || null,
      before_state_hash: beforeState ? designStateHash(beforeState) : null,
      after_state_hash: designStateHash(state),
      before_state: beforeState ? clone(beforeState) : null,
      after_state: state
    }
  };
}
