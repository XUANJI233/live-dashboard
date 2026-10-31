export type DeviceInfoItem = {
  label: string;
  value: string;
  unit?: string;
  /** Shown as separate tags instead of the value (capabilities); the hint is the plain name on hover. */
  chips?: Array<{ label: string; hint?: string }>;
  icon?: string;
  /** Hover text, such as the raw code behind a friendly value. */
  title?: string;
};

/** One device fact. Long values wrap inside the card and step down in size instead of overflowing. */
export default function DeviceInfoCard({ item }: { item: DeviceInfoItem }) {
  return (
    <div className="min-w-0 rounded border border-dashed border-[var(--color-border)] px-3 py-2" title={item.title}>
      <div className="text-[10px] text-[var(--color-text-muted)]">{item.label}</div>
      {item.chips ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {item.chips.length > 0 ? item.chips.map((chip) => (
            <span
              key={chip.label}
              title={chip.hint}
              className="rounded-full border border-[var(--color-border)] px-1.5 text-[10px] leading-4 text-[var(--color-primary)]"
            >
              {chip.label}
            </span>
          )) : <span className="text-xs text-[var(--color-text-muted)]">{item.value}</span>}
        </div>
      ) : (
        <div className={`font-mono text-[var(--color-primary)] [overflow-wrap:anywhere] ${valueSize(item.value)}`}>
          {item.icon && <span className="mr-1" aria-hidden="true">{item.icon}</span>}
          {item.value}
          {item.unit && <span className="ml-1 text-[10px] text-[var(--color-text-muted)]">{item.unit}</span>}
        </div>
      )}
    </div>
  );
}

// Width in half-width cells: CJK counts double. Short values keep the card's size.
function valueSize(value: string): string {
  const width = Array.from(value).reduce((sum, char) => sum + ((char.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1), 0);
  if (width <= 14) return "text-sm";
  if (width <= 22) return "text-xs";
  return "text-[11px] leading-tight";
}
