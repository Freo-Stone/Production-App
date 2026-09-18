import logoUrl from '@/assets/logo.png';
import markUrl from '@/assets/logo-mark.svg';
import { cx } from '@/ui/primitives';

/**
 * The shop's brand, in one place so the shell and the sign-in screen cannot drift
 * into two different-looking logos for the same shop.
 *
 * Both files are drawn from `brand/freo-stone-paving.jpg` by `scripts/make-brand.py`,
 * which is also where the launcher icons come from — so the tile in this header, the
 * icon on a phone's home screen and the logo on the sign-in screen are the same
 * artwork at three sizes, rather than three drawings that nearly agree.
 *
 * The tile is the block device on the logo's own white card — the same card, the same
 * fill and the same rounding the launcher icons get, so the header tile and the icon
 * on a home screen are one drawing. No lettering: at 28px it is mush, and the shapes
 * are what carry the shop at that size.
 *
 * The card is not decoration. This sits on the app's dark chrome, where a charcoal
 * foot on a dark background sinks away and leaves four red corners floating around a
 * blue slab — which reads as a broken image. Where there is room to be read, use
 * `BrandLogo`, which is the real thing.
 */
export function Brand({ compact = false }: { compact?: boolean }): React.ReactElement {
  return (
    <div className="flex items-center gap-2">
      {/* Named only when it is the whole label. Beside the words it would be read
          twice: "Freo Stone, Freo Stone Production". */}
      <img
        src={markUrl}
        alt={compact ? 'Freo Stone' : ''}
        width={28}
        height={28}
        className="size-7 shrink-0"
      />
      {!compact ? (
        <span className="min-w-0">
          <span className="block truncate text-[0.86rem] font-700 leading-tight">Freo Stone</span>
          <span className="block truncate text-[0.68rem] leading-tight text-ink3">Production</span>
        </span>
      ) : null}
    </div>
  );
}

/**
 * The logo itself — the square lockup with the lettering in it. It belongs where it
 * has room to be read, which in this app is the sign-in screen: the first thing
 * anyone sees when they pick up a device, and the one place the shop's own artwork
 * is worth its full size.
 */
export function BrandLogo({ className }: { className?: string }): React.ReactElement {
  return (
    <img
      src={logoUrl}
      alt="Freo Stone Paving"
      width={390}
      height={388}
      className={cx('h-16 w-auto', className)}
    />
  );
}
