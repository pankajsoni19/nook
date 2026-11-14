import { useEffect, useState } from "react";
import type { CrmFieldDef, CrmFieldValue } from "../../shared/crm";
import type { PersonSummary } from "../../shared/people";
import { resolvePeople } from "../ui/workspaceApi";

/**
 * Names for custom person and contact field values (D1206). Values are ids; GET /api/people/resolve
 * turns them into chips, a contact the viewer can't read into "A contact" (T640). Names are cached
 * for the session so tables, record pages, and filter chips agree without asking twice.
 */
const cache = new Map<string, PersonSummary>();

export const relationName = (person: PersonSummary | undefined) =>
  !person ? undefined : person.kind === "contact" && person.hidden ? "A contact" : "name" in person ? person.name : undefined;

/** Remembers a chip a picker returned, so a filter or cell shows its name at once. */
export function rememberPerson(person: PersonSummary) {
  if ("id" in person) cache.set(person.id, person);
}

export const cachedPerson = (id: string) => cache.get(id);

/** id → name for every person and contact value in `records`, loading the ones not cached yet. */
export function useRelationNames(fields: readonly CrmFieldDef[], records: ReadonlyArray<{ custom: Record<string, CrmFieldValue> }>): ReadonlyMap<string, string> {
  const relation = fields.filter((field) => field.type === "person" || field.type === "contact");
  const wanted = (type: "person" | "contact") => [...new Set(records.flatMap((record) => relation.filter((field) => field.type === type).map((field) => record.custom[field.id]).filter((value): value is string => typeof value === "string")))];
  const users = wanted("person");
  const contacts = wanted("contact");
  const key = `${users.join(",")}|${contacts.join(",")}`;
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const missingUsers = users.filter((id) => !cache.has(id));
    const missingContacts = contacts.filter((id) => !cache.has(id));
    if (!missingUsers.length && !missingContacts.length) return;
    let active = true;
    resolvePeople({ users: missingUsers, contacts: missingContacts }).then((result) => {
      for (const person of result.people) rememberPerson(person);
      if (active) setVersion((value) => value + 1);
    }).catch(() => undefined);
    return () => { active = false; };
    // `key` captures both id lists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const names = new Map<string, string>();
  void version;
  for (const id of [...users, ...contacts]) {
    const name = relationName(cache.get(id));
    if (name) names.set(id, name);
  }
  return names;
}
