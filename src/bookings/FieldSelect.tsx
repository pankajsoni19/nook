import { useId } from "react";
import { Select } from "../ui/Select";

/**
 * A labelled field with the shared Select (D91: no native selects in the app). `""` stands for
 * "none" (the first option), mapped to null by the caller.
 */
export function FieldSelect({ label, value, options, onChange, disabled = false }: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return <div className="ui-field">
    <span id={id}>{label}</span>
    <Select labelledBy={id} value={value || "__none"} options={options.map((option) => ({ value: option.value || "__none", label: option.label }))}
      onChange={(next) => onChange(next === "__none" ? "" : next)} disabled={disabled} />
  </div>;
}

/** Every IANA zone the browser knows, as options ("Europe/Berlin" → "Europe/Berlin" with spaces). */
export function zoneOptions(current: string) {
  let zones: string[];
  try { zones = Intl.supportedValuesOf("timeZone"); } catch { zones = ["UTC"]; }
  if (!zones.includes(current)) zones = [current, ...zones];
  return zones.map((zone) => ({ value: zone, label: zone.replace(/_/g, " ") }));
}
