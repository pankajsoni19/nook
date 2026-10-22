import { providerFlavor, type ProviderFlavor } from "../../../shared/agents";
import { anthropicAdapter } from "./anthropic";
import { openaiAdapter } from "./openai";
import type { ProviderAdapter } from "./types";
import { voyageAdapter } from "./voyage";

export type { EmbeddingInputType, ProviderAdapter, ProviderKind } from "./types";

const ADAPTERS: Record<ProviderFlavor, ProviderAdapter> = { anthropic: anthropicAdapter, voyage: voyageAdapter };

/** The adapter of a kind (D543); null, a plain OpenAI-compatible endpoint, is the OpenAI kind. */
export const adapterFor = (flavor: ProviderFlavor | null | undefined): ProviderAdapter => (flavor ? ADAPTERS[flavor] : null) ?? openaiAdapter;

/** The adapter of a provider by its base URL and stored compat (`providerFlavor`: host first, then `compat.flavor`). */
export const adapterOfProvider = (baseUrl: string, compat?: { flavor?: ProviderFlavor | null } | null) => adapterFor(providerFlavor(baseUrl, compat));

/** The adapter of a resolved connection (`connectionFor` sets its `flavor`). */
export const adapterOf = (connection: { flavor?: ProviderFlavor | null }) => adapterFor(connection.flavor);
