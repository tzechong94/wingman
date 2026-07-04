"use client";

import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import type { MemoryEntity, MemoryEpisode, MemoryNote } from "@/lib/types";
import { useFetch } from "@/lib/use-fetch";
import { useEffect } from "react";
import { BrainIcon, DatabaseIcon, PinIcon, RefreshIcon } from "../icons";
import { Button, CenteredState, StatusChip } from "../ui";

const POLL_MS = 10_000;

/**
 * Judge-facing view of the agent's Engram memory layer: episodic memories,
 * consolidated semantic notes, and extracted entities. Polls while mounted.
 */
export function MemoryTab() {
  const { data, loading, error, reload } = useFetch(() => api.memory());

  // Background poll while the tab is mounted; reload keeps stale data visible
  // so the list doesn't flash back to a skeleton on every tick.
  useEffect(() => {
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  if (loading && data === null) {
    return (
      <div className="space-y-3 px-4 py-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg bg-panel-2/40">
            <span className="sr-only">Loading…</span>
          </div>
        ))}
      </div>
    );
  }

  if (error && data === null) {
    return (
      <CenteredState
        title="Couldn't load memory"
        hint="The memory endpoint didn't respond — check that the Wingman host is running."
        action={
          <Button size="sm" onClick={reload}>
            Retry
          </Button>
        }
      />
    );
  }

  if (data === null) return null;

  if (!data.available) {
    return (
      <CenteredState
        icon={<DatabaseIcon className="size-6" />}
        title="Memory store not reachable"
        hint="Engram's Postgres container isn't running."
        action={
          <Button size="sm" onClick={reload}>
            Retry
          </Button>
        }
      />
    );
  }

  const episodes = [...data.episodes].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) || b.lastAccessedAt - a.lastAccessedAt,
  );

  return (
    <div className="space-y-5 px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <p className="max-w-lg text-sm text-muted">
          Live view of the agent&apos;s Engram memory — what it remembers about
          this business&apos;s customers, and how often each memory is recalled.
        </p>
        <div className="flex items-center gap-2">
          {data.tenant && <StatusChip tone="success" label={data.tenant} />}
          <Button
            size="sm"
            variant="ghost"
            onClick={reload}
            disabled={loading}
            aria-label="Refresh memory"
          >
            <RefreshIcon className="size-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      <section className="space-y-2">
        <SectionHeading label="Episodes" count={episodes.length} />
        {episodes.length === 0 ? (
          <SectionEmpty text="No episodes yet — memories form as customers talk to the agent." />
        ) : (
          <ul className="space-y-2">
            {episodes.map((ep, i) => (
              <EpisodeCard key={i} episode={ep} />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <SectionHeading label="Semantic notes" count={data.notes.length} />
        {data.notes.length === 0 ? (
          <SectionEmpty text="Consolidated knowledge appears here after Engram's sleep cycle runs." />
        ) : (
          <ul className="space-y-2">
            {data.notes.map((note, i) => (
              <NoteCard key={i} note={note} />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <SectionHeading label="Entities" count={data.entities.length} />
        {data.entities.length === 0 ? (
          <SectionEmpty text="People, products and places the agent has learned appear here after Engram's sleep cycle runs." />
        ) : (
          <EntityCloud entities={data.entities} />
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <h3 className="flex items-baseline gap-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">
      {label}
      <span className="font-normal text-faint tabular-nums">{count}</span>
    </h3>
  );
}

function SectionEmpty({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center">
      <p className="text-xs text-faint">{text}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

function EpisodeCard({ episode }: { episode: MemoryEpisode }) {
  const recalled = episode.accessCount > 0;
  return (
    <li className="rounded-lg border border-line/60 bg-panel px-3 py-2.5">
      <p className="text-sm text-ink">{episode.content}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {episode.sourceChannel && (
          <StatusChip tone="neutral" label={episode.sourceChannel} />
        )}
        <Meter label="importance" value={episode.importance} />
        <span
          className={
            recalled
              ? "inline-flex items-center gap-1 text-[11px] font-semibold text-accent tabular-nums"
              : "text-[11px] text-faint tabular-nums"
          }
        >
          {recalled && <BrainIcon className="size-3" />}
          recalled {episode.accessCount}×
        </span>
        {episode.pinned && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent-strong">
            <PinIcon className="size-3" />
            Pinned
          </span>
        )}
        {episode.status && episode.status !== "active" && (
          <StatusChip tone="warning" label={episode.status} />
        )}
        <span
          className="ml-auto text-[11px] whitespace-nowrap text-faint tabular-nums"
          title="Last recalled"
        >
          {recalled
            ? `recalled ${timeAgo(episode.lastAccessedAt)}`
            : `added ${timeAgo(episode.createdAt)}`}
        </span>
      </div>
    </li>
  );
}

/** Small horizontal 0–1 meter with a percentage readout. */
function Meter({ label, value }: { label: string; value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={`${label} ${pct}%`}
      aria-label={`${label} ${pct}%`}
    >
      <span className="h-1 w-12 overflow-hidden rounded-full bg-panel-2">
        <span
          className="block h-full rounded-full bg-accent"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="text-[11px] text-muted tabular-nums">{pct}%</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Semantic notes
// ---------------------------------------------------------------------------

function NoteCard({ note }: { note: MemoryNote }) {
  return (
    <li className="rounded-lg border border-line/60 bg-panel px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-ink">{note.title}</p>
        {note.kind && <StatusChip tone="neutral" label={note.kind} />}
      </div>
      {note.body && <p className="mt-1 text-sm text-muted">{note.body}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Meter label="confidence" value={note.confidence} />
        <span className="ml-auto text-[11px] whitespace-nowrap text-faint tabular-nums">
          updated {timeAgo(note.updatedAt)}
        </span>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

function EntityCloud({ entities }: { entities: MemoryEntity[] }) {
  const sorted = [...entities].sort((a, b) => b.salience - a.salience);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {sorted.map((entity, i) => (
        <EntityChip key={i} entity={entity} />
      ))}
    </div>
  );
}

function EntityChip({ entity }: { entity: MemoryEntity }) {
  const salience = Math.min(1, Math.max(0, entity.salience));
  // Scale 11px→15px and 400→600 with salience so important entities pop.
  const fontSize = 11 + Math.round(salience * 4);
  const fontWeight = salience >= 0.66 ? 600 : salience >= 0.33 ? 500 : 400;
  return (
    <span
      className="inline-flex items-baseline gap-1 rounded-full border border-line bg-panel px-2.5 py-1 text-ink"
      style={{ fontSize, fontWeight }}
      title={`${entity.type || "entity"} · salience ${Math.round(salience * 100)}%`}
    >
      {entity.type && (
        <span className="text-[10px] font-normal text-faint">{entity.type}</span>
      )}
      {entity.name}
    </span>
  );
}
