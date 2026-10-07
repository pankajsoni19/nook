import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentDetail, AgentProviderChoice } from "../shared/agents";
import { agentRowDetail, DEFAULT_PROVIDER, editorDiffers, effectiveProvider, modelSuggestions, ProviderModelFields, providerOptions, type EditorForm } from "../src/chat/AgentsSettings";
import { createRow } from "../src/ui/Combobox";

/** The agent editor's Provider picker and Model combobox, the dirty check, and the list row's line. */

const providers: AgentProviderChoice[] = [
  { id: "p-alpha", name: "Alpha", isDefault: true, defaultModel: "alpha-large", models: ["alpha-large", "alpha-small"] },
  { id: "p-beta", name: "Beta", isDefault: false, defaultModel: "beta-1", models: null }
];

const agent: AgentDetail = {
  id: "a1", ownerId: "u1", name: "Helper", description: "Answers", icon: null, color: null, providerId: "p-beta", model: null, maxSteps: 8, temperature: null, maxOutputTokens: null,
  starters: [], revision: 1, createdAt: "", updatedAt: "", isOwner: true, tools: [], nookDirectWrites: false, linked: false, linkState: "none", trifecta: false,
  yourLevel: "owner", ownerName: "Me", usesNook: false, hiddenTools: 0, providerName: "Beta", effectiveModel: "beta-1", systemPrompt: "Be brief."
};
const form: EditorForm = { name: "Helper", description: "Answers", icon: "", systemPrompt: "Be brief.", providerId: "p-beta", model: "", maxSteps: 8, temperature: "", starters: "", directWrites: false, tools: [] };

describe("the Provider picker", () => {
  test("Default names the default provider and means providerId null; then each provider by name", () => {
    expect(providerOptions(providers)).toEqual([
      { value: DEFAULT_PROVIDER, label: "Default (Alpha)" },
      { value: "p-alpha", label: "Alpha" },
      { value: "p-beta", label: "Beta" }
    ]);
    expect(providerOptions([])).toEqual([{ value: DEFAULT_PROVIDER, label: "Default" }]);
  });

  test("the effective provider: the chosen one, else the default (also for a deleted one)", () => {
    expect(effectiveProvider(providers, "p-beta")?.name).toBe("Beta");
    expect(effectiveProvider(providers, null)?.name).toBe("Alpha");
    expect(effectiveProvider(providers, "p-gone")?.name).toBe("Alpha");
    expect(effectiveProvider([], null)).toBeNull();
  });

  test("model suggestions: the known models, else just the default model", () => {
    expect(modelSuggestions(providers[0]!)).toEqual([{ value: "alpha-large", label: "alpha-large (default)" }, { value: "alpha-small", label: "alpha-small" }]);
    expect(modelSuggestions(providers[1]!)).toEqual([{ value: "beta-1", label: "beta-1 (default)" }]);
    expect(modelSuggestions(null)).toEqual([]);
  });

  test("free text in the model combobox reads “Use …”, not Create", () => {
    expect(createRow("my-model", [], true, (text) => `Use “${text}”`)?.label).toBe("Use “my-model”");
    expect(createRow("my-model", [], true)?.label).toBe("Create “my-model”");
  });

  test("renders a custom Select (never a native select) and a combobox whose placeholder is the chosen provider's default model", () => {
    const ids = { provider: "prov", model: "mod" };
    const html = renderToStaticMarkup(<ProviderModelFields ids={ids} providers={providers} providerId="p-beta" model="" onProvider={() => undefined} onModel={() => undefined} />);
    expect(html).not.toContain("<select");
    expect(html).toContain("Beta");
    expect(html).toContain('placeholder="beta-1 (the provider&#x27;s default)"');
    expect(html).toContain('role="combobox"');
    const fallback = renderToStaticMarkup(<ProviderModelFields ids={ids} providers={providers} providerId={null} model="alpha-small" onProvider={() => undefined} onModel={() => undefined} />);
    expect(fallback).toContain("Default (Alpha)");
    expect(fallback).toContain("alpha-small");
    // A deleted provider (or one the list does not have) shows Default.
    expect(renderToStaticMarkup(<ProviderModelFields ids={ids} providers={providers} providerId="p-gone" model="" onProvider={() => undefined} onModel={() => undefined} />)).toContain("Default (Alpha)");
    expect(renderToStaticMarkup(<ProviderModelFields ids={ids} providers={null} providerId={null} model="" onProvider={() => undefined} onModel={() => undefined} />)).toContain("Loading providers");
  });
});

describe("dirty state and save", () => {
  test("changing the provider makes the form dirty; equal is clean", () => {
    expect(editorDiffers(agent, form)).toBe(false);
    expect(editorDiffers(agent, { ...form, providerId: null })).toBe(true);
    expect(editorDiffers(agent, { ...form, providerId: "p-alpha" })).toBe(true);
    expect(editorDiffers({ ...agent, providerId: null }, { ...form, providerId: null })).toBe(false);
  });

  test("save sends providerId and model; a reload (Changed elsewhere) refills the provider", async () => {
    const source = await Bun.file(new URL("../src/chat/AgentsSettings.tsx", import.meta.url)).text();
    expect(source).toContain("systemPrompt, providerId, model: model.trim() || null, maxSteps,");
    expect(source).toContain("setProviderId(detail.providerId);");
    expect(source).toContain("editorDiffers(agent, { name, description, icon, systemPrompt, providerId, model,");
  });
});

describe("the list row and the read-only view", () => {
  test("the row names the provider only when the agent has its own", () => {
    expect(agentRowDetail(agent, "gpt-6-luna")).toBe("Answers · Beta · beta-1 · 8 steps");
    expect(agentRowDetail({ ...agent, providerId: null, providerName: null, model: "alpha-small", effectiveModel: "alpha-small" }, "gpt-6-luna")).toBe("Answers · alpha-small · 8 steps");
    // An older server without effectiveModel: the status's default model.
    expect(agentRowDetail({ ...agent, providerName: null, effectiveModel: undefined as unknown as null }, "gpt-6-luna")).toBe("Answers · gpt-6-luna · 8 steps");
  });
});
