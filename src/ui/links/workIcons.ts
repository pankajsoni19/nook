import {
  Building2, Calendar, CalendarCheck, CalendarDays, CalendarPlus, ChartColumn, ClipboardList, Clock, File, FileText, FolderClock, Gauge, Handshake,
  KanbanSquare, Link2, Megaphone, MessageCircle, MessageCircleQuestion, MessageSquareText, MessagesSquare, PenTool, Rows3, SquareCheck, Table2, Target, Timer, Contact,
  type LucideIcon
} from "lucide-react";
import { WORK_KIND_ICONS, type WorkKind } from "../../../shared/workRefs";

/** The lucide icons a WorkSummary may name (shared/workRefs.ts WORK_KIND_ICONS), by name. */
const ICONS: Record<string, LucideIcon> = {
  "square-check": SquareCheck, "kanban-square": KanbanSquare, timer: Timer, "file-text": FileText, file: File, "pen-tool": PenTool, "calendar-days": CalendarDays,
  calendar: Calendar, "table-2": Table2, "rows-3": Rows3, "chart-column": ChartColumn, "clipboard-list": ClipboardList, "message-square-text": MessageSquareText,
  clock: Clock, "folder-clock": FolderClock, target: Target, gauge: Gauge, "message-circle": MessageCircle, "messages-square": MessagesSquare, contact: Contact,
  "building-2": Building2, handshake: Handshake, "calendar-check": CalendarCheck, "calendar-plus": CalendarPlus, megaphone: Megaphone,
  "message-circle-question": MessageCircleQuestion
};

/** A summary's icon by name, else its kind's, else a link. Unknown names never render arbitrary content. */
export const workIcon = (name: string | undefined, kind?: WorkKind): LucideIcon => (name && ICONS[name]) || (kind && ICONS[WORK_KIND_ICONS[kind]]) || Link2;
