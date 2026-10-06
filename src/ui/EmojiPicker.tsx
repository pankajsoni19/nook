import { useEffect, useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { SmilePlus, X } from "lucide-react";
import { EMOJI_CATEGORIES } from "./emojiData";
import { emojiGridMove, emojiLabel, emojiSections, readRecentEmoji, rememberRecentEmoji } from "./emojiModel";
import { DropdownSurface, useOutsideClose, useSheet, type Presentation } from "./Listbox";
import "./emojiPicker.css";

// A reusable emoji picker (D91 family, like ReactionPicker): a button showing the current emoji opens
// a fixed-position popover on desktop and a bottom sheet on phones (≤ 760 px). Both are history
// layers (useHistoryDialogGuard inside DropdownSurface), so browser Back closes only the picker.
// The popover renders in the owner's subtree; glyphs and names come from a fixed table (emojiData).

export const EMOJI_COLUMNS = { popup: 8, sheet: 7 } as const;

type EmojiPickerProps = {
  value: string;
  onChange: (glyph: string) => void;
  /** What the emoji is for, in the trigger's name ("Agent emoji"). */
  label?: string;
  /** Shown on the trigger, dimmed, while no emoji is set (what the app falls back to). */
  placeholder?: string;
  presentation?: Presentation;
  disabled?: boolean;
};

export function EmojiPicker({ value, onChange, label = "Emoji", placeholder, presentation = "auto", disabled = false }: EmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const sheet = useSheet(presentation);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLSpanElement>(null);
  const current = value.trim();
  // Desktop: Tab out of the popover closes it (it is not a focus trap). The phone sheet traps Tab.
  const onBlur = (event: FocusEvent<HTMLSpanElement>) => {
    const next = event.relatedTarget as Node | null;
    if (open && !sheet && next && !containerRef.current?.contains(next)) setOpen(false);
  };
  return <span ref={containerRef} className="emoji-picker" onBlur={onBlur}>
    <button ref={triggerRef} type="button" className={`emoji-picker-trigger${current ? "" : " empty"}`} disabled={disabled}
      aria-haspopup="dialog" aria-expanded={open}
      aria-label={`${label}: ${current ? emojiLabel(current) : "none"}. Choose an emoji`} title="Choose an emoji"
      onClick={() => setOpen(!open)}
      onKeyDown={(event) => { if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>
      {current ? <span aria-hidden="true">{current}</span> : placeholder ? <span className="emoji-picker-placeholder" aria-hidden="true">{placeholder}</span> : <SmilePlus aria-hidden="true" />}
    </button>
    {open && <EmojiPickerPanel value={current} sheet={sheet} anchorRef={triggerRef} containerRef={containerRef} title={`Choose ${label.toLowerCase()}`}
      onPick={onChange} onClose={() => setOpen(false)} />}
  </span>;
}

type PanelProps = {
  value: string;
  sheet: boolean;
  anchorRef: RefObject<HTMLButtonElement | null>;
  containerRef: RefObject<HTMLElement | null>;
  title: string;
  onPick: (glyph: string) => void;
  onClose: () => void;
};

export function EmojiPickerPanel({ value, sheet, anchorRef, containerRef, title, onPick, onClose }: PanelProps) {
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState(() => readRecentEmoji());
  const sections = useMemo(() => emojiSections(query, recent), [query, recent]);
  const flat = useMemo(() => sections.flatMap((section) => section.emoji), [sections]);
  const sizes = useMemo(() => sections.map((section) => section.emoji.length), [sections]);
  const [active, setActive] = useState(() => Math.max(0, flat.findIndex((emoji) => emoji.glyph === value)));
  const cells = useRef<Array<HTMLButtonElement | null>>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyId = useId();
  const columns = sheet ? EMOJI_COLUMNS.sheet : EMOJI_COLUMNS.popup;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Escape, a pick, Remove, the sheet's Close, or Back: the picker goes and the trigger has focus again.
  const close = useRef(() => {
    closeRef.current();
    anchorRef.current?.focus();
  }).current;
  useOutsideClose(!sheet, containerRef, onClose);
  // The popover is hidden until it is placed: focus once it is visible. The phone sheet focuses the
  // current emoji rather than the search box, so the keyboard does not cover the grid.
  useEffect(() => {
    // A timeout rather than a frame: it runs after the popup's placement render even where frames
    // are not painted (a background tab).
    const timer = setTimeout(() => {
      if (sheet) cells.current[active]?.focus();
      else searchRef.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
    // Only when the picker opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (glyph: string) => {
    setRecent(rememberRecentEmoji(glyph, undefined, recent));
    onPick(glyph);
    close();
  };
  const onEscape = (event: ReactKeyboardEvent) => {
    if (event.key !== "Escape") return false;
    // A host dialog handles Escape too; this one is the picker's.
    event.preventDefault();
    event.stopPropagation();
    close();
    return true;
  };
  const focusCell = (index: number) => {
    setActive(index);
    cells.current[index]?.focus();
  };
  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (onEscape(event)) return;
    if (event.key === "Enter") {
      // Never submit the form the picker sits in.
      event.preventDefault();
      if (flat[0]) pick(flat[0].glyph);
    } else if (event.key === "ArrowDown" && flat.length > 0) {
      event.preventDefault();
      focusCell(Math.min(active, flat.length - 1));
    }
  };
  const onGridKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (onEscape(event)) return;
    if (event.key === "Enter" && flat[active] && event.target === cells.current[active]) {
      // Picked here rather than by the button's default click, so Enter never reaches the form.
      event.preventDefault();
      pick(flat[active]!.glyph);
      return;
    }
    if (event.key === "ArrowUp" && emojiGridMove(sizes, columns, active, "ArrowUp") === active && !sheet) {
      // Up from the first row returns to the search box.
      event.preventDefault();
      searchRef.current?.focus();
      return;
    }
    const next = emojiGridMove(sizes, columns, active, event.key);
    if (next === null) return;
    event.preventDefault();
    focusCell(next);
  };
  const jumpTo = (sectionId: string) => {
    setQuery("");
    setTimeout(() => {
      const heading = document.getElementById(`${bodyId}-${sectionId}`);
      const body = heading?.closest<HTMLElement>(".ui-popup-body, .ui-sheet-body");
      if (heading && body) body.scrollTop = heading.offsetTop - body.offsetTop;
    }, 0);
  };

  const search = <div className="emoji-picker-head" onKeyDown={(event) => { onEscape(event); }}>
    <div className="ui-search">
      <input ref={searchRef} type="search" aria-label="Search emoji" placeholder="Search emoji" value={query} autoComplete="off" spellCheck={false} enterKeyHint="done"
        aria-controls={bodyId} onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={onSearchKey} />
    </div>
    <div className="emoji-picker-jump" role="group" aria-label="Categories">
      {EMOJI_CATEGORIES.map((category) => <button key={category.id} type="button" aria-label={category.label} title={category.label} onClick={() => jumpTo(category.id)}>
        <span aria-hidden="true">{category.icon}</span>
      </button>)}
    </div>
  </div>;
  const footer = value ? <div className="emoji-picker-footer" onKeyDown={(event) => { onEscape(event); }}>
    <span className="emoji-picker-current"><span aria-hidden="true">{value}</span> {emojiLabel(value)}</span>
    <button type="button" className="secondary-button" onClick={() => { onPick(""); close(); }}><X aria-hidden="true" />Remove emoji</button>
  </div> : undefined;

  let index = 0;
  return <DropdownSurface sheet={sheet} anchorRef={anchorRef} title={title} onClose={close} search={search} footer={footer}>
    <div id={bodyId} className="emoji-picker-body" onKeyDown={onGridKey}>
      {flat.length === 0 && <p className="emoji-picker-empty" role="status">No emoji match “{query.trim()}”.</p>}
      {sections.filter((section) => section.emoji.length > 0).map((section) => <section key={section.id} className="emoji-picker-section" aria-labelledby={`${bodyId}-${section.id}`}>
        <h5 id={`${bodyId}-${section.id}`}>{section.label}</h5>
        <div className="emoji-picker-grid" role="group" aria-label={section.label}>
          {section.emoji.map((emoji) => {
            const at = index++;
            return <button key={emoji.glyph} ref={(node) => { cells.current[at] = node; }} type="button" className="emoji-picker-cell"
              tabIndex={at === active ? 0 : -1} aria-label={emoji.name} title={emoji.name} aria-pressed={emoji.glyph === value}
              onFocus={() => setActive(at)} onClick={() => pick(emoji.glyph)}>
              <span aria-hidden="true">{emoji.glyph}</span>
            </button>;
          })}
        </div>
      </section>)}
    </div>
  </DropdownSurface>;
}
