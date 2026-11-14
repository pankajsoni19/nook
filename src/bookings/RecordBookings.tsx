import { useEffect, useId, useState } from "react";
import { CalendarCheck2, CalendarPlus, Link2 } from "lucide-react";
import { api } from "../api";
import { notify } from "../ui/notify";
import { TONE_ICONS } from "../ui/tone";
import { openEmbedPicker, type PickItem } from "../ui/embeds/openEmbedPicker";
import type { ItemSlotProps, ItemSlotPerson } from "../ui/itemSlots";
import { bookingPrefillUrl, STATUS_LABELS, STATUS_TONES } from "../../shared/bookings";
import { dayLabel, timeLabel, viewerZone, type Booking } from "./api";
import "./bookings.css";

/**
 * Bookings on a contact, company, or deal page (C20, D1058), an item section (src/ui/itemSlots.ts):
 * the record's bookings (a contact's, a company's people's, a deal's contacts'; only those the viewer
 * could open in Bookings), and **Send booking link**, which copies one of your public booking links
 * prefilled with the contact's name and email (nothing else goes in the URL).
 */

type MineType = { href: string; title: string; status: string; publicPath: string | null; durations: number[] };

const bookableTypes = (): Promise<PickItem[]> => api<{ types: MineType[] }>("/bookings/types?mine=1").then(({ types }) => types
  .filter((type) => type.status === "active" && type.publicPath)
  .map((type) => ({ id: type.href, title: type.title, meta: type.durations.map((minutes) => `${minutes} min`).join(" / "), path: type.publicPath! })));

async function copyLink(path: string, person: ItemSlotPerson | null | undefined) {
  const url = bookingPrefillUrl(window.location.origin, path, person ?? null);
  try {
    await navigator.clipboard.writeText(url);
    notify.success(person ? `Booking link for ${person.name} copied` : "Booking link copied");
  } catch {
    notify.info(url, { selectable: true });
  }
}

export async function sendBookingLink(person: ItemSlotPerson | null | undefined) {
  const types = await bookableTypes().catch(() => [] as PickItem[]);
  if (types.length === 1) { await copyLink(types[0]!.path, person); return; }
  openEmbedPicker({
    title: "Send a booking link", eyebrow: "Bookings", icon: CalendarPlus, emptyTitle: "No public booking types", emptyText: "Make a booking type public and active in Bookings first.",
    load: () => Promise.resolve(types)
  }, (item) => { void copyLink(item.path, person); });
}

export default function RecordBookings({ kind, id, readOnly, onOpen, person }: ItemSlotProps) {
  const [items, setItems] = useState<Booking[] | null>(null);
  const [failed, setFailed] = useState(false);
  const headingId = useId();
  const tz = viewerZone();
  useEffect(() => {
    let live = true;
    api<{ items: Booking[]; truncated: boolean }>(`/bookings/for/${kind}/${encodeURIComponent(id)}`).then((body) => { if (live) setItems(body.items); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [kind, id]);
  if (failed) return null;
  return <section className="ui-item-section bk-record-section" aria-labelledby={headingId}>
    <header className="ui-panel-header">
      <h3 id={headingId}><CalendarCheck2 aria-hidden="true" />Bookings{items && items.length > 0 && <span className="ui-panel-count"> · {items.length}</span>}</h3>
      {!readOnly && <button type="button" className="secondary-button ui-small-button" onClick={() => { void sendBookingLink(person); }}><Link2 aria-hidden="true" />Send booking link</button>}
    </header>
    {items === null ? <p className="ui-panel-loading" role="status">Loading bookings…</p> : items.length === 0
      ? <p className="bk-muted">No bookings yet.</p>
      : <ul className="bk-record-list">{items.map((booking) => {
        const tone = STATUS_TONES[booking.status];
        const Icon = TONE_ICONS[tone];
        return <li key={booking.id}>
          <a href={booking.href} onClick={(event) => { if (onOpen) { event.preventDefault(); onOpen(booking.href); } }}>
            <span className="bk-record-title">{booking.typeTitle}{kind !== "contact" ? ` · ${booking.bookerName}` : ""}</span>
            <span className="bk-record-when">{dayLabel(booking.start, tz, { weekday: "short", day: "numeric", month: "short" })}, {timeLabel(booking.start, tz)}</span>
            <span className="bk-status ui-tone" data-tone={tone}><Icon aria-hidden="true" />{STATUS_LABELS[booking.status]}</span>
          </a>
        </li>;
      })}</ul>}
  </section>;
}
