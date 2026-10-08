import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { embeddingSuggestions, policyDraft, policyFromDraft, policySummary, ProviderKnowledgeFields } from "../src/chat/ProviderKnowledgePolicy";
import { dimsLimitText, sheetChoice } from "../src/chat/KnowledgeModel";
import type { KnowledgeEmbeddingChoice } from "../shared/knowledge";

/**
 * The admin's knowledge policy, client side (2026-10-08): the provider editor's Knowledge bases group
 * (Any model or a list through the app's own chips, D91; the largest size, empty for no limit), and
 * Change embedding model's sheet showing only what the policy allows, with the limit stated.
 */

const src = join(import.meta.dir, "..", "src");
const read = (path: string) => readFileSync(join(src, path), "utf8");
const choice = (patch: Partial<KnowledgeEmbeddingChoice> = {}): KnowledgeEmbeddingChoice => ({
  id: "p", name: "OpenAI", isDefault: true, embeddingModel: "text-embedding-3-large", embeddingDims: 768, models: ["text-embedding-3-large"], anyModel: false, maxDims: 768, ...patch
});

describe("the provider editor's Knowledge bases group", () => {
  test("Any model is the default; a list needs a model; the size is 64 to 3,072 or empty", () => {
    expect(policyDraft(undefined)).toEqual({ enabled: true, anyModel: true, models: [], maxDims: "" });
    expect(policyFromDraft(policyDraft(undefined))).toEqual({ policy: { enabled: true, models: null, maxDims: null } });
    expect(policyFromDraft({ enabled: true, anyModel: false, models: [], maxDims: "" })).toEqual({ error: "Add at least one embedding model, or choose Any model." });
    expect(policyFromDraft({ enabled: true, anyModel: false, models: ["text-embedding-3-small"], maxDims: "1024" })).toEqual({ policy: { enabled: true, models: ["text-embedding-3-small"], maxDims: 1024 } });
    for (const bad of ["32", "4096", "512.5", "abc"]) expect("error" in policyFromDraft({ enabled: true, anyModel: true, models: [], maxDims: bad })).toBe(true);
    expect(policyFromDraft({ enabled: false, anyModel: true, models: [], maxDims: "" })).toEqual({ policy: { enabled: false, models: null, maxDims: null } });
    // A stored policy round-trips into the draft.
    expect(policyDraft({ enabled: true, models: ["a"], maxDims: 256 })).toEqual({ enabled: true, anyModel: false, models: ["a"], maxDims: "256" });
  });

  test("suggestions leave chat models out when embedding models can be told apart by name", () => {
    expect(embeddingSuggestions(["gpt-6-luna", "text-embedding-3-small", "nomic-embed-text"])).toEqual(["text-embedding-3-small", "nomic-embed-text"]);
    expect(embeddingSuggestions(["bge-m3", "e5-large"])).toEqual(["bge-m3", "e5-large"]);
    expect(embeddingSuggestions(["bad id with spaces", "x-embed"])).toEqual(["x-embed"]);
  });

  test("the provider card's line", () => {
    expect(policySummary({ enabled: true, models: null, maxDims: null })).toBe("Any model, up to 3,072 dimensions");
    expect(policySummary({ enabled: true, models: ["a", "b"], maxDims: 1024 })).toBe("2 models, up to 1,024 dimensions");
    expect(policySummary({ enabled: false, models: null, maxDims: null })).toBe("Not allowed");
  });

  test("renders Any model / Only these as the app's own pills, the chips only for a list, and the size field", () => {
    const any = renderToStaticMarkup(<ProviderKnowledgeFields providerId={null} draft={policyDraft(undefined)} onChange={() => undefined} />);
    expect(any).toContain("Knowledge bases");
    expect(any).toContain("Knowledge bases may use this provider");
    expect(any).toContain('aria-pressed="true">Any model</button>');
    expect(any).toContain('aria-pressed="false">Only these</button>');
    expect(any).toContain("Largest size (dimensions)");
    expect(any).toContain('placeholder="3,072 (no limit)"');
    expect(any).not.toContain("Add an embedding model");
    expect(any).not.toContain("<select");
    const list = renderToStaticMarkup(<ProviderKnowledgeFields providerId={null} draft={{ enabled: true, anyModel: false, models: ["text-embedding-3-small"], maxDims: "512" }} onChange={() => undefined} />);
    expect(list).toContain('aria-pressed="true">Only these</button>');
    expect(list).toContain("text-embedding-3-small");
    expect(list).toContain('value="512"');
    expect(list).not.toContain("<select");
    const off = renderToStaticMarkup(<ProviderKnowledgeFields providerId={null} draft={{ enabled: false, anyModel: true, models: [], maxDims: "" }} onChange={() => undefined} />);
    expect(off).not.toContain("Largest size");
    // Saved with the rest of the provider.
    const settings = read("chat/AiSettings.tsx");
    expect(settings).toContain("knowledge: policy.policy, expectedRevision: provider.revision");
    expect(settings).toContain("<ProviderKnowledgeFields providerId={provider?.id ?? null}");
  });
});

describe("Change embedding model's sheet under a policy", () => {
  test("starts on the base's own model and size when allowed, else the allowed default, the size capped", () => {
    expect(sheetChoice(choice({ anyModel: true, models: null, maxDims: 3072 }), { model: "text-embedding-3-small", dims: 1024 })).toEqual({ model: "text-embedding-3-small", dims: 1024 });
    expect(sheetChoice(choice(), { model: "text-embedding-3-small", dims: 1024 })).toEqual({ model: "text-embedding-3-large", dims: 768 });
    expect(sheetChoice(choice(), { model: "text-embedding-3-large", dims: 256 })).toEqual({ model: "text-embedding-3-large", dims: 256 });
    expect(sheetChoice(choice(), null)).toEqual({ model: "text-embedding-3-large", dims: 768 });
  });

  test("the dimensions field states the admin's limit", () => {
    expect(dimsLimitText(1024)).toBe("64 to 1,024: an admin's limit for this provider.");
    expect(dimsLimitText(3072)).toBe("64 to 3,072.");
  });

  test("a model list means pills only (no free text), the size input is capped, and the submit checks both", () => {
    const sheet = read("chat/KnowledgeModel.tsx");
    expect(sheet).toContain("provider && !provider.anyModel ? <>");
    expect(sheet).toContain("An admin allows only these embedding models with {provider.name}.");
    expect(sheet).toContain("max={provider?.maxDims ?? 3072}");
    expect(sheet).toContain("if (!provider.anyModel && !provider.models?.includes(name))");
    expect(sheet).toContain("size! > provider.maxDims");
    // The free-text model field appears only in the Any branch.
    const anyBranch = sheet.slice(sheet.indexOf("provider && !provider.anyModel ? <>"));
    expect(anyBranch.indexOf("<input id={ids.model}")).toBeGreaterThan(anyBranch.indexOf("</> : <>"));
  });
});
