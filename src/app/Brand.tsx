/**
 * The wordmark, in one place so the shell header and the sign-in screen cannot
 * drift into two different-looking logos for the same shop.
 */
export function Brand({ compact = false }: { compact?: boolean }): React.ReactElement {
  return (
    <div className="flex items-center gap-2">
      <span className="grid size-7 shrink-0 place-items-center rounded-[7px] bg-accent text-[0.78rem] font-800 text-accentink">
        FS
      </span>
      {!compact ? (
        <span className="min-w-0">
          <span className="block truncate text-[0.86rem] font-700 leading-tight">Freo Stone</span>
          <span className="block truncate text-[0.68rem] leading-tight text-ink3">Production</span>
        </span>
      ) : null}
    </div>
  );
}
