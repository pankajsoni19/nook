import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import type { FormDetail, FormListItem } from "../../shared/forms";

/**
 * The editor's `/poll` and `/form` (D835): a small dialog mounted on its own (the editor knows only
 * the registry), which creates a poll or picks one of your forms, then hands it back to insert the
 * embed. Loaded on first use.
 */
const NewPollDialog = lazy(() => import("./NewSheets").then((mod) => ({ default: mod.SlashPollDialog })));
const FormPickerDialog = lazy(() => import("./NewSheets").then((mod) => ({ default: mod.FormPickerDialog })));

function mount(render: (close: () => void) => React.ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => { root.unmount(); host.remove(); };
  root.render(<Suspense fallback={null}>{render(close)}</Suspense>);
}

export function openNewPollDialog(onCreated: (form: Pick<FormDetail, "kind" | "href">) => void) {
  mount((close) => <NewPollDialog onClose={close} onCreated={(form) => { close(); onCreated(form); }} />);
}

export function openFormPicker(onPick: (form: Pick<FormListItem, "kind" | "href">) => void) {
  mount((close) => <FormPickerDialog onClose={close} onPick={(form) => { close(); onPick(form); }} />);
}
