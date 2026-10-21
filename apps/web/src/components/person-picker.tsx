"use client";

import { ChevronDown, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { api, type PersonList, type PersonRow } from "@/lib/api";
import { cn } from "@/lib/utils";

type Option = { value: string; label: string };

const names = new Map<string, string>();

/**
 * Picks one person by searching (S9): the list is never loaded whole, so it
 * works the same for three people or thirty thousand. `extra` options (such as
 * "All people") come first.
 */
export function PersonPicker(props: {
  value: string;
  onChange: (id: string) => void;
  label: string;
  placeholder?: string;
  extra?: Option[];
  className?: string;
}) {
  const { value, extra = [] } = props;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<PersonRow[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // The chosen person's name, fetched once if it isn't known yet.
  useEffect(() => {
    if (!value || extra.some((o) => o.value === value)) return setSelectedName(null);
    const known = names.get(value);
    if (known) return setSelectedName(known);
    api<{ displayName: string }>(`/admin/persons/${encodeURIComponent(value)}`)
      .then((p) => {
        names.set(value, p.displayName);
        setSelectedName(p.displayName);
      })
      .catch(() => setSelectedName(value));
  }, [value, extra]);

  // Search as they type (a little after they stop).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ limit: "8", ...(q.trim() ? { q: q.trim() } : {}) });
      api<PersonList>(`/admin/persons?${qs}`)
        .then((r) => {
          for (const p of r.items) names.set(p.id, p.displayName);
          setFound(r.items);
        })
        .catch(() => setFound([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);

  // Closes on a click elsewhere.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function choose(id: string) {
    props.onChange(id);
    setOpen(false);
    setQ("");
  }

  const shown =
    extra.find((o) => o.value === value)?.label ??
    selectedName ??
    props.placeholder ??
    "Choose a person";

  return (
    <div ref={box} className={cn("relative w-56", props.className)}>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${props.label}-options`}
        aria-label={props.label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        className="flex h-8 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-2.5 text-left text-sm shadow-xs"
      >
        <span className="truncate">{shown}</span>
        <ChevronDown className="size-4 shrink-0 opacity-50" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-72 rounded-md border bg-popover p-1 shadow-md">
          <div className="flex items-center gap-1 px-1 pb-1">
            <Search className="size-4 text-muted-foreground" />
            <Input
              autoFocus
              aria-label={`Search: ${props.label}`}
              placeholder="Search name, email, record…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
              className="h-8 border-0 shadow-none focus-visible:ring-0"
            />
          </div>
          <div role="listbox" id={`${props.label}-options`} className="max-h-64 overflow-y-auto">
            {[...extra, ...found.map((p) => ({ value: p.id, label: p.displayName }))].map((o) => (
              <div
                key={o.value}
                role="option"
                tabIndex={-1}
                aria-selected={o.value === value}
                onClick={() => choose(o.value)}
                onKeyDown={(e) => e.key === "Enter" && choose(o.value)}
                className={cn(
                  "cursor-pointer rounded-sm px-2 py-1.5 text-sm hover:bg-muted",
                  o.value === value && "font-medium",
                )}
              >
                {o.label}
              </div>
            ))}
            {found.length === 0 && (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">No one found.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
