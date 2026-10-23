import { useCallback, useEffect, useRef, useState } from "react";
import { ArchiveRestore, CircleCheck, CloudUpload, DatabaseBackup, HardDrive, LoaderCircle, RotateCcw, ShieldCheck, TriangleAlert } from "lucide-react";
import { api, ApiError } from "../api";
import { formatDateTime, relativeTime } from "../files/format";
import { formatBytes } from "../files/filesApi";
import { notify } from "../ui/notify";
import type { BackupRun, BackupsView, DrillReport } from "../../shared/backups";
import { HUB_TITLE_ID } from "./hubModel";
import "../reports/reports.css";
import "./backups.css";

const TARGET_WORDS = { local: "This server's disk", s3: "S3", both: "This server's disk and S3" } as const;
const TRIGGER_WORDS = { schedule: "Scheduled", manual: "Back up now", cli: "Command line" } as const;

const messageOf = (reason: unknown, fallback: string) => reason instanceof ApiError || reason instanceof Error ? reason.message || fallback : fallback;

/** "2 h ago · 12.4 MB · S3 and this server's disk" for a run. */
/** What an archive holds (D612, D687: BACKUP_S3_OBJECTS=copy adds the bucket's files, with their size from the database). */
export function holdsText(settings: Pick<BackupsView["settings"], "storage" | "objects" | "objectsEstimate">) {
  if (settings.storage !== "s3") return "The database, note Markdown, files, and pictures.";
  if (settings.objects !== "copy") return "The database and the data directory. Files stay in the S3 bucket and are not copied; keep bucket versioning on.";
  const estimate = settings.objectsEstimate;
  return `The database, the data directory, and a copy of the bucket's files (BACKUP_S3_OBJECTS=copy)${estimate ? `: ${estimate.count.toLocaleString("en-US")} ${estimate.count === 1 ? "file" : "files"}, about ${formatBytes(estimate.bytes)} more in every backup` : ""}.`;
}

function runLine(run: BackupRun) {
  const where = run.targets?.filter((target) => target.ok).map((target) => target.kind === "s3" ? "S3" : "this server's disk") ?? [];
  return [relativeTime(run.finishedAt), run.archive ? formatBytes(run.archive.size) : null, where.length ? where.join(" and ") : null].filter(Boolean).join(" · ");
}

/**
 * Settings → Backups (lane BACKUP, D618; admins). Online backups as `.env` sets them (read only here),
 * the last run and the next, "Back up now", the restore drill and "Run restore drill", Litestream's
 * replication, and the archives in each place. While a job runs the page polls every 3 seconds.
 */
export function Backups() {
  const [view, setView] = useState<BackupsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<"backup" | "drill" | null>(null);
  const wasRunning = useRef<BackupsView["running"]>(null);

  const load = useCallback(async () => {
    try {
      const next = await api<BackupsView>("/admin/backups");
      // A job this page saw running has finished: say how it went.
      const finished = wasRunning.current && !next.running ? wasRunning.current.kind : null;
      wasRunning.current = next.running;
      setView(next);
      setError(null);
      if (finished === "backup") {
        const last = next.status.lastRun;
        if (last?.ok) notify.success(`Backup finished: ${last.archive ? formatBytes(last.archive.size) : "done"}`);
        else if (last) notify.error(`Backup failed: ${last.error ?? "see Settings → Backups"}`);
      } else if (finished === "drill") {
        const last = next.drill.last;
        if (last?.ok) notify.success("Restore drill passed");
        else if (last) notify.error("Restore drill failed");
      }
    } catch (reason) {
      setError(messageOf(reason, "Could not load backups"));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const running = view?.running ?? null;
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => { void load(); }, 3000);
    return () => window.clearInterval(timer);
  }, [running, load]);

  async function start(kind: "backup" | "drill") {
    setStarting(kind);
    try {
      await api(kind === "backup" ? "/admin/backups/run" : "/admin/backups/drill", { method: "POST", body: JSON.stringify({}) });
      notify.success(kind === "backup" ? "Backup started" : "Restore drill started");
      await load();
    } catch (reason) {
      notify.error(messageOf(reason, kind === "backup" ? "Could not start a backup" : "Could not start the drill"));
    } finally {
      setStarting(null);
    }
  }

  if (error && !view) return <section className="settings-content backups-settings" aria-labelledby={HUB_TITLE_ID}>
    <div className="team-state team-error" role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button></div>
  </section>;
  if (!view) return <section className="settings-content backups-settings" aria-labelledby={HUB_TITLE_ID} aria-busy="true"><p className="team-loading" role="status">Loading backups…</p></section>;

  const { settings, status } = view;
  const last = status.lastRun;
  const busy = running !== null || starting !== null;
  const s3Where = settings.s3 ? `s3://${settings.s3.bucket}/${settings.s3.prefix} (${settings.s3.endpointHost})` : null;
  const litestream = view.litestream;

  return <section className="settings-content backups-settings report-sources" aria-labelledby={HUB_TITLE_ID} aria-describedby="backups-intro">
    <div className="settings-section-heading"><span className="settings-icon"><DatabaseBackup /></span><div><p id="backups-intro">Online backups copy the database and the data directory while Nook keeps running, on the schedule set in the server's <code>.env</code>. Restore drills check that a backup really restores.</p></div></div>

    <ul className="report-source-list" aria-label="Backup status">
      <li className="report-source">
        <div className="report-source-head">
          <strong><HardDrive aria-hidden="true" />Online backups{!settings.enabled && <span className="reports-status">Schedule off</span>}{status.consecutiveFailures > 0 && <span className="reports-status reports-status-error">{status.consecutiveFailures === 1 ? "Last run failed" : `${status.consecutiveFailures} failed in a row`}</span>}</strong>
          <small>{running?.kind === "backup" ? `Backing up since ${relativeTime(running.startedAt)}…${running.progress ? ` ${running.progress}` : ""}` : status.lastSuccess ? `Last good backup ${runLine(status.lastSuccess)}` : "No backup yet"}</small>
        </div>
        {last && !last.ok && <div className="report-test failed" role="status"><p><TriangleAlert aria-hidden="true" />{last.error ?? "The last run failed"} <span className="backups-when">({relativeTime(last.finishedAt)})</span></p></div>}
        {status.lastSuccess?.warnings?.map((warning) => <p key={warning} className="backups-warning"><TriangleAlert aria-hidden="true" />{warning}</p>)}
        <dl className="report-source-facts">
          <div><dt>Schedule</dt><dd>{settings.enabled ? `Every ${durationWords(settings.interval)}, keeping the newest ${settings.keep}` : "Off (BACKUP_ENABLED=false); Back up now still works"}</dd></div>
          <div><dt>Next</dt><dd>{running?.kind === "backup" ? "Running now" : view.nextBackupAt ? `${relativeTime(view.nextBackupAt)} (${formatDateTime(view.nextBackupAt)})` : "Not scheduled"}</dd></div>
          <div><dt>Kept on</dt><dd>{TARGET_WORDS[settings.target]}</dd></div>
          {settings.target !== "s3" && <div><dt>Folder</dt><dd><code>{settings.localDir}</code></dd></div>}
          {s3Where && <div><dt>Bucket</dt><dd><code>{s3Where}</code>{settings.s3?.sse === "required" ? " · encryption at rest required" : ""}</dd></div>}
          <div><dt>Holds</dt><dd>{holdsText(settings)}</dd></div>
          <div><dt>Alerts</dt><dd>Admins are told after {settings.alertAfter} failed {settings.alertAfter === 1 ? "run" : "runs in a row"}</dd></div>
        </dl>
        <div className="report-source-actions">
          <button type="button" className="secondary-button" onClick={() => { void start("backup"); }} disabled={busy} aria-busy={running?.kind === "backup" || starting === "backup" || undefined}>
            {running?.kind === "backup" || starting === "backup" ? <LoaderCircle className="spin" aria-hidden="true" /> : <CloudUpload aria-hidden="true" />}{running?.kind === "backup" ? "Backing up…" : "Back up now"}
          </button>
        </div>
      </li>

      <li className="report-source">
        <div className="report-source-head">
          <strong><ShieldCheck aria-hidden="true" />Restore drill{view.drill.last && <span className={`reports-status ${view.drill.last.ok ? "reports-status-ready" : "reports-status-error"}`}>{view.drill.last.ok ? "Passed" : "Failed"}</span>}</strong>
          <small>{running?.kind === "drill" ? `Restoring into a scratch folder since ${relativeTime(running.startedAt)}…` : view.drill.last ? `Last drill ${relativeTime(view.drill.last.finishedAt)}: ${view.drill.last.source}` : "Restores the newest backup into a scratch folder, checks it, and removes it"}</small>
        </div>
        {view.drill.last && <DrillChecks report={view.drill.last} />}
        <dl className="report-source-facts">
          <div><dt>Schedule</dt><dd>{settings.drillInterval ? `Every ${durationWords(settings.drillInterval)}${view.nextDrillAt ? `, next ${relativeTime(view.nextDrillAt)}` : ""}` : "By hand (set BACKUP_DRILL_INTERVAL to schedule it)"}</dd></div>
        </dl>
        <div className="report-source-actions">
          <button type="button" className="secondary-button" onClick={() => { void start("drill"); }} disabled={busy || view.archives.length === 0} aria-busy={running?.kind === "drill" || starting === "drill" || undefined}>
            {running?.kind === "drill" || starting === "drill" ? <LoaderCircle className="spin" aria-hidden="true" /> : <ArchiveRestore aria-hidden="true" />}{running?.kind === "drill" ? "Running drill…" : "Run restore drill"}
          </button>
        </div>
      </li>

      <li className="report-source">
        <div className="report-source-head">
          <strong><RotateCcw aria-hidden="true" />Litestream{litestream.active ? <span className="reports-status reports-status-ready">Replicating</span> : litestream.configured ? <span className="reports-status reports-status-stale">Not running</span> : <span className="reports-status">Off</span>}</strong>
          <small>{litestream.configured ? "Continuous copies of the database to S3, for a restore to any point in time" : litestream.enabled ? "LITESTREAM_ENABLED=true, but no S3 bucket is configured" : "Set LITESTREAM_ENABLED=true (with an S3 bucket) for continuous copies of the database"}</small>
        </div>
        {litestream.configured && <dl className="report-source-facts">
          {litestream.location && <div><dt>Replica</dt><dd><code>{litestream.location}</code></dd></div>}
          <div><dt>Last upload</dt><dd>{litestream.replica ? `${relativeTime(litestream.replica.uploadedAt)}${litestream.metrics ? litestream.replica.txid >= litestream.metrics.txid ? ", up to date" : `, ${litestream.metrics.txid - litestream.replica.txid} transaction${litestream.metrics.txid - litestream.replica.txid === 1 ? "" : "s"} behind` : ""}` : "Nothing uploaded yet"}</dd></div>
          {litestream.replica?.snapshotAt && <div><dt>Snapshot</dt><dd>{relativeTime(litestream.replica.snapshotAt)}</dd></div>}
          {litestream.retention && <div><dt>Restores</dt><dd>To any time in the last {durationWords(litestream.retention)}</dd></div>}
          {litestream.metrics && litestream.metrics.syncErrors > 0 && <div><dt>Errors</dt><dd className="form-error">{litestream.metrics.syncErrors} sync errors since Litestream started</dd></div>}
          {!litestream.active && <div><dt>Note</dt><dd>This server was not started by the image's start script under Litestream (restart the container after setting LITESTREAM_ENABLED).</dd></div>}
          {litestream.error && <div><dt>Check</dt><dd className="form-error">{litestream.error}</dd></div>}
        </dl>}
      </li>
    </ul>

    <h4 className="backups-subheading">Backups</h4>
    {view.archivesError && <p className="backups-warning"><TriangleAlert aria-hidden="true" />{view.archivesError}</p>}
    {view.archives.length === 0 ? <p className="file-dialog-hint">No backups yet.</p> : <ul className="backups-archives" aria-label="Backups">
      {view.archives.map((archive) => <li key={archive.name}>
        <span className="backups-archive-name"><code>{archive.name}</code>{archive.offline && <span className="reports-status">Offline</span>}</span>
        <small>{formatDateTime(archive.createdAt)} · {formatBytes(archive.size)} · {archive.locations.map((place) => place === "s3" ? "S3" : "disk").join(" and ")}</small>
      </li>)}
    </ul>}

    {status.recent.length > 0 && <>
      <h4 className="backups-subheading">Recent runs</h4>
      <ul className="backups-archives" aria-label="Recent runs">
        {status.recent.slice(0, 8).map((run) => <li key={run.id}>
          <span className="backups-archive-name">{run.ok ? <CircleCheck className="backups-ok" aria-label="Succeeded" /> : <TriangleAlert className="backups-failed" aria-label="Failed" />}{TRIGGER_WORDS[run.trigger]} · {formatDateTime(run.startedAt)}</span>
          <small>{run.ok ? `${run.archive ? formatBytes(run.archive.size) : ""} in ${(run.ms / 1000).toFixed(1)} s` : run.error ?? "Failed"}</small>
        </li>)}
      </ul>
    </>}
  </section>;
}

function DrillChecks({ report }: { report: DrillReport }) {
  return <ul className="backups-checks" aria-label="Drill checks">
    {report.checks.map((check) => <li key={check.name} className={check.ok ? check.warning ? "warn" : "ok" : "failed"}>
      {check.ok && !check.warning ? <CircleCheck aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
      <span><strong>{check.name}</strong> {check.detail}</span>
    </li>)}
  </ul>;
}

const UNIT_WORDS: Record<string, [string, string]> = { m: ["minute", "minutes"], h: ["hour", "hours"], d: ["day", "days"], w: ["week", "weeks"] };
/** "6h" → "6 hours", "1d" → "day". */
function durationWords(value: string) {
  const match = /^(\d+)([mhdw])$/.exec(value);
  if (!match) return value;
  const count = Number(match[1]);
  const [one, many] = UNIT_WORDS[match[2]!]!;
  return count === 1 ? one : `${count} ${many}`;
}
