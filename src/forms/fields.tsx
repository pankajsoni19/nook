import { useId, type ReactNode } from "react";
import { Select } from "../ui/Select";

/** A labelled select (the shared Select, its visible label above it, as every `.ui-field`). */
export function SelectField<V extends string>({ label, value, onChange, options, hint, disabled }: { label: string; value: V | null; onChange: (value: V) => void; options: Array<{ value: V; label: string }>; hint?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return <div className="ui-field">
    <span id={id}>{label}</span>
    <Select labelledBy={id} label={label} value={value} onChange={onChange} options={options} disabled={disabled} />
    {hint && <span className="ui-field-hint">{hint}</span>}
  </div>;
}

/** The shared switch look (`.ui-switch`, as ItemTimeline's): a labelled on/off button. */
export function Toggle({ label, checked, onChange, hint, disabled }: { label: string; checked: boolean; onChange: (value: boolean) => void; hint?: ReactNode; disabled?: boolean }) {
  return <div className="forms-toggle">
    <button type="button" role="switch" className="ui-switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="ui-switch-track" aria-hidden="true"><span className="ui-switch-thumb" /></span><span className="forms-toggle-label">{label}</span>
    </button>
    {hint && <span className="ui-field-hint">{hint}</span>}
  </div>;
}
