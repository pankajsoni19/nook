/**
 * The confirm for leaving an API key that is shown only once (C1): switching Settings section, or
 * leaving the Settings page (Home, Bin, Inbox, the bell, sign-out, Back or Forward); and (Wave 36
 * review R4) leaving an integration's page in Team → Integrations with its new key still on screen.
 * Switching API keys' tabs (General, Vault, Agents) asks too: the key is not shown on the next tab.
 * Closing the browser tab is not guarded.
 */
export function unsavedKeyConfirm(action: "section" | "tab" | "leave" | "integration") {
  const where = action === "section" ? "Leave this section" : action === "tab" ? "Switch tabs" : action === "integration" ? "Leave this integration" : "Leave Settings";
  return {
    title: "Leave without saving the key?",
    message: `This API key is shown only once. ${where} without copying it? You would have to rotate or create a key again.`,
    confirmLabel: action === "section" ? "Leave section" : action === "tab" ? "Switch tab" : "Leave without saving",
    danger: true
  };
}
