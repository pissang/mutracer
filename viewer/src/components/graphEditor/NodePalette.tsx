import { useEffect, useMemo, useRef, useState } from 'react';
import type { MaterialGraph } from '@meimu/mutracer';
import { nodeChoices, type AddAnchor, type NodeChoice } from '../../engine/graphEdit';

export interface PaletteRequest {
  x: number; y: number;
  position: { x: number; y: number };
  anchor?: AddAnchor;
}

/** Cursor-local node search, also used to continue a wire into empty space. */
export function NodePalette({ request, graph, onAdd, onClose }: {
  request: PaletteRequest; graph: MaterialGraph;
  onAdd: (choice: NodeChoice) => void; onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const choices = useMemo(() => nodeChoices(graph, request.anchor), [graph, request.anchor]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return choices.filter(c => `${c.category} ${c.type} ${c.port ?? ''}`.includes(q))
      .sort((a, b) => Number(b.category === q) - Number(a.category === q) || Number(b.category.startsWith(q)) - Number(a.category.startsWith(q)));
  }, [choices, query]);
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [onClose]);
  useEffect(() => { menu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active, query]);
  return (
    <div ref={menu} className="gx-palette__menu nodrag nopan nowheel" role="dialog" aria-label="Add node"
      style={{ left: request.x, top: request.y }} onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault(); setActive(i => Math.max(0, Math.min(filtered.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))));
        } else if (e.key === 'Enter' && filtered[active]) { e.preventDefault(); onAdd(filtered[active]); }
      }}>
      <input autoFocus placeholder={request.anchor ? 'Search compatible nodes…' : 'Search nodes…'} aria-label="Search nodes"
        role="combobox" aria-expanded="true" aria-controls="gx-node-options" aria-autocomplete="list"
        aria-activedescendant={filtered[active] ? `gx-option-${active}` : undefined}
        value={query} onChange={e => { setQuery(e.currentTarget.value); setActive(0); }} />
      <div className="gx-palette__list" id="gx-node-options" role="listbox" aria-label="Nodes">
        {filtered.map((choice, i) => <button key={`${choice.category}:${choice.type}:${choice.port}`} id={`gx-option-${i}`}
          role="option" aria-selected={i === active} onPointerMove={() => setActive(i)} onClick={() => onAdd(choice)}>
          <span>{choice.category}</span><small>{request.anchor ? `${choice.type} · ${choice.port}` : choice.type}</small>
        </button>)}
        {!filtered.length && <div className="gx-palette__empty">No compatible nodes</div>}
      </div>
    </div>
  );
}
