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
 * The tile is the mark — the block device on the logo's own white card, with the same
 * fill and rounding the launcher icons get, so the header tile and the icon on a home
 * screen are one drawing. It is used where there is no room to read: a 56px collapsed
 * rail and the 48px header on a phone. At 28px the lettering inside the logo is mush,
 * and the shapes are what carry the shop at that size; `make-brand.py` cuts the mark
 * out of the same artwork for precisely that reason.
 *
 * Where the rail is open there *is* room to read, and the shop's own lettered logo is
 * what belongs there. This used to show the mark and type the shop's name beside it,
 * which is the app describing the brand instead of wearing it — the logo was only ever
 * on the sign-in screen, so once you were in, the shop's artwork had left the building.
 *
 * The white card around the artwork is not decoration. It sits on the app's dark
 * chrome, where a charcoal foot on a dark background sinks away and leaves four red
 * corners floating around a blue slab, which reads as a broken image.
 */
export function Brand({ compact = false }: { compact?: boolean }): React.ReactElement {
  if (compact) {
    return <img src={markUrl} alt="Freo Stone" width={28} height={28} className="size-7 shrink-0" />;
  }
  return (
    <div className="flex items-center gap-2.5">
      {/* The logo already spells FREO STONE PAVING, so the shop's name is not typed
          beside it — that would be read twice, and it is the lettering in the artwork
          that this change is about. What is left to say is which of the shop's tools
          this is. */}
      <img src={logoUrl} alt="Freo Stone Paving" width={44} height={44} className="size-11 shrink-0" />
      <span className="min-w-0 truncate text-[0.68rem] leading-tight text-ink3">Production</span>
    </div>
  );
}

/**
 * The logo at the size it was drawn for. It belongs where it has room to be read at
 * full scale, which is the sign-in screen: the first thing anyone sees when they pick
 * up a device, and the one place the artwork is worth its full size.
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
