import { registerActivityKinds } from "./itemActivity";

/**
 * The Forms module's item activity kinds (§B.5): a form's history (title, who answers, status,
 * publishing, its public link, a time poll's final time) and a response's ("submitted"). Payloads hold
 * labels and counts only, never answers (T505).
 */
export const FORM_ACTIVITY = registerActivityKinds("forms", {
  title: { shape: "change", coalesce: true },
  audience: { shape: "change", coalesce: false },
  status: { shape: "change", coalesce: false },
  published: { shape: "event", coalesce: false },
  public_link: { shape: "event", coalesce: false },
  finalized: { shape: "event", coalesce: false },
  submitted: { shape: "event", coalesce: false }
});
