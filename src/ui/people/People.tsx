import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Building2, Contact, Loader2, Plus, UserRound, Users, X } from "lucide-react";
import { Avatar, avatarInitial } from "../Avatar";
import { errorText } from "../notify";
import { searchPeople } from "../workspaceApi";
import { contactDisplayName, emailDomain, type PeopleAllow, type PersonSummary } from "../../../shared/people";
import "../workspace.css";

/**
 * People (§B.3, §E.3, D839): one chip and one picker for team users, groups, and contacts. A contact
 * whose book the viewer cannot read is "A contact" with nothing else (T503); a former member keeps
 * their name and says so.
 */

/** A stable key for a person in lists. */
export const personKey = (person: PersonSummary) => person.kind === "guest" ? `guest:${person.email}` : `${person.kind}:${person.id}`;

/** What a person is called on a chip, and the second line a picker shows. */
export function personText(person: PersonSummary): { name: string; detail: string | null } {
  if (person.kind === "contact" && person.hidden) return { name: "A contact", detail: null };
  if (person.kind === "user") return { name: person.name, detail: person.former ? "Former member" : person.email ?? null };
  if (person.kind === "group") return { name: person.name, detail: person.memberCount !== undefined ? `Group · ${person.memberCount} ${person.memberCount === 1 ? "person" : "people"}` : "Group" };
  if (person.kind === "contact") return { name: person.name, detail: [person.companyName, person.email].filter(Boolean).join(" · ") || "Contact" };
  return { name: person.name || contactDisplayName({ email: person.email }), detail: person.email };
}

export function PersonChip({ person, onRemove, onOpen, size = "normal" }: {
  person: PersonSummary;
  onRemove?: () => void;
  /** Opens the contact or the member (in-app path). */
  onOpen?: () => void;
  size?: "normal" | "small";
}) {
  const { name } = personText(person);
  const hidden = person.kind === "contact" && person.hidden;
  const former = person.kind === "user" && person.former;
  const badge = person.kind === "contact" && !hidden ? "Contact" : person.kind === "guest" ? "Guest" : former ? "Former member" : null;
  const face = person.kind === "user"
    ? <Avatar className="ui-person-avatar" name={person.name} url={person.avatarUrl ?? null} integration={person.integration} />
    : <span className="ui-person-avatar" aria-hidden="true">{person.kind === "group" ? <Users /> : person.kind === "contact" && hidden ? <Contact /> : avatarInitial(name)}</span>;
  const Body = onOpen && !hidden ? "button" : "span";
  return <span className={`ui-person${size === "small" ? " small" : ""}${former ? " former" : ""}${hidden ? " hidden" : ""}`} data-kind={person.kind}>
    <Body className="ui-person-body" {...(Body === "button" ? { type: "button" as const, onClick: onOpen } : {})} title={badge ? `${name} · ${badge}` : name}>
      {face}<span className="ui-person-name">{name}</span>{badge && <span className="ui-person-badge">{badge}</span>}
    </Body>
    {onRemove && <button type="button" className="ui-person-remove" onClick={onRemove} aria-label={`Remove ${name}`} title="Remove"><X /></button>}
  </span>;
}

/** A company: its initial, name, and domain. */
export function CompanyChip({ name, domain, onOpen }: { name: string; domain?: string | null; onOpen?: () => void }) {
  const Body = onOpen ? "button" : "span";
  return <span className="ui-person ui-company">
    <Body className="ui-person-body" {...(Body === "button" ? { type: "button" as const, onClick: onOpen } : {})} title={domain ? `${name} · ${domain}` : name}>
      <span className="ui-person-avatar square" aria-hidden="true"><Building2 /></span><span className="ui-person-name">{name}</span>{domain && <span className="ui-person-badge">{domain}</span>}
    </Body>
  </span>;
}

export type NewContact = { name: string; email: string };

/**
 * Pick people: type to search users, groups, and readable contacts (GET /api/people/search), arrows
 * and Enter to choose, Backspace on an empty box removes the last. With `onCreateContact`, a typed
 * email that matches nobody offers "Add contact" (inline create, §B.3).
 */
export function PersonPicker({ label, value, onChange, allow = ["user"], bookId, multiple = true, onCreateContact, placeholder, disabled = false }: {
  label: string;
  value: readonly PersonSummary[];
  onChange: (people: PersonSummary[]) => void;
  allow?: readonly PeopleAllow[];
  bookId?: string;
  multiple?: boolean;
  /** Creates a contact from a typed name and email and returns it (the module decides the book). */
  onCreateContact?: (contact: NewContact) => Promise<PersonSummary>;
  placeholder?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PersonSummary[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = new Set(value.map(personKey));

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      searchPeople(query.trim(), allow, { book: bookId, signal: controller.signal }).then((body) => {
        if (controller.signal.aborted) return;
        setResults(body.people.filter((person) => !chosen.has(personKey(person))).slice(0, 20));
        setActive(0);
        setLoading(false);
        setError(null);
      }, (reason) => { if (!controller.signal.aborted) { setLoading(false); setError(errorText(reason, "Could not search people")); } });
    }, 150);
    return () => { controller.abort(); window.clearTimeout(timer); };
    // `chosen` is derived from value; allow is a constant list per caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open, bookId, value.length]);

  const typedEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query.trim()) ? query.trim() : null;
  const offerCreate = Boolean(onCreateContact && allow.includes("contact") && typedEmail && !results.some((person) => person.kind === "contact" && !person.hidden && person.email?.toLowerCase() === typedEmail.toLowerCase()));
  const options = results.length + (offerCreate ? 1 : 0);

  const choose = (person: PersonSummary) => {
    onChange(multiple ? [...value, person] : [person]);
    setQuery("");
    if (!multiple) setOpen(false);
    inputRef.current?.focus();
  };
  const create = async () => {
    if (!onCreateContact || !typedEmail) return;
    const name = contactDisplayName({ email: typedEmail });
    try { choose(await onCreateContact({ name, email: typedEmail })); }
    catch (reason) { setError(errorText(reason, "Could not add the contact")); }
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActive((index) => options ? (index + 1) % options : 0); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => options ? (index - 1 + options) % options : 0); }
    else if (event.key === "Enter" && open && options) {
      event.preventDefault();
      if (active < results.length) choose(results[active]!);
      else void create();
    } else if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    else if (event.key === "Backspace" && !query && value.length) onChange(value.slice(0, -1));
  };

  return <div className={`ui-field ui-person-picker${disabled ? " disabled" : ""}`}>
    <label htmlFor={`${id}-input`}>{label}</label>
    <div className="ui-person-field" onClick={() => inputRef.current?.focus()}>
      {value.map((person) => <PersonChip key={personKey(person)} person={person} size="small" onRemove={disabled ? undefined : () => onChange(value.filter((item) => personKey(item) !== personKey(person)))} />)}
      {(multiple || value.length === 0) && <input ref={inputRef} id={`${id}-input`} type="text" role="combobox" aria-expanded={open && options > 0} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={open && options ? `${id}-opt-${active}` : undefined} autoComplete="off" value={query} disabled={disabled}
        placeholder={value.length ? "" : placeholder ?? (allow.includes("contact") ? "Name or email" : "Name")}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 120)} onKeyDown={onKeyDown} />}
      {loading && open && <Loader2 className="spin ui-person-spinner" aria-hidden="true" />}
    </div>
    {open && (options > 0 || error || (!loading && query.trim())) && <ul id={listId} className="ui-person-options" role="listbox" aria-label={label}>
      {results.map((person, index) => {
        const text = personText(person);
        return <li key={personKey(person)} id={`${id}-opt-${index}`} role="option" aria-selected={index === active} className={index === active ? "active" : undefined}
          onMouseDown={(event) => { event.preventDefault(); choose(person); }} onMouseEnter={() => setActive(index)}>
          <PersonChip person={person} size="small" />{text.detail && <small>{text.detail}</small>}
        </li>;
      })}
      {offerCreate && <li id={`${id}-opt-${results.length}`} role="option" aria-selected={active === results.length} className={`ui-person-create${active === results.length ? " active" : ""}`}
        onMouseDown={(event) => { event.preventDefault(); void create(); }}>
        <Plus aria-hidden="true" />Add contact <strong>{typedEmail}</strong>{emailDomain(typedEmail) && <small>{emailDomain(typedEmail)}</small>}
      </li>}
      {!loading && options === 0 && !error && <li className="ui-person-empty" role="presentation"><UserRound aria-hidden="true" />No one matches “{query.trim()}”.</li>}
      {error && <li className="ui-person-empty ui-field-error" role="presentation">{error}</li>}
    </ul>}
  </div>;
}
