import { navigate } from '@/app/router';
import { Button, Card, Chip, EmptyState } from '@/ui/primitives';
import { Icon, type IconName } from '@/ui/Icon';

/**
 * Placeholder for screens that are still in the build order.
 *
 * Every screen is reachable from launch so the shell, routing and layout can be
 * exercised on a phone before the logic behind each screen lands.
 */
export function UnderConstruction({
  title,
  icon,
  blurb,
  steps,
}: {
  title: string;
  icon: IconName;
  blurb: string;
  steps?: string[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <Card
        title={
          <span className="flex items-center gap-2">
            <Icon name={icon} size={16} className="text-accent" />
            {title}
          </span>
        }
        subtitle={blurb}
        actions={<Chip tone="warn">In build</Chip>}
      >
        <EmptyState
          icon={icon}
          title={`${title} is not wired up yet`}
          body={
            steps && steps.length > 0 ? (
              <ul className="mt-1 space-y-1 text-left">
                {steps.map((s) => (
                  <li key={s} className="flex gap-2">
                    <span className="text-ink3">·</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            ) : (
              'This screen lands later in the build order. The rest of the app is usable now.'
            )
          }
          action={
            <Button size="sm" onClick={() => navigate('/')}>
              Back to the matrix
            </Button>
          }
        />
      </Card>
    </div>
  );
}
