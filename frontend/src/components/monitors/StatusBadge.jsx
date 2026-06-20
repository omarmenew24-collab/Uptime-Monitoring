import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const variants = {
  up: 'bg-emerald-950 text-emerald-400 border-emerald-800',
  down: 'bg-red-950 text-red-400 border-red-800',
  timeout: 'bg-amber-950 text-amber-400 border-amber-800',
  paused: 'bg-zinc-800 text-zinc-400 border-zinc-700',
};

const labels = {
  up: 'UP',
  down: 'DOWN',
  timeout: 'TIMEOUT',
};

export default function StatusBadge({ status, isActive = true }) {
  const variant = !isActive ? 'paused' : (status || 'paused');
  const label = !isActive ? 'PAUSED' : (labels[status] || 'PENDING');

  return (
    <Badge
      variant="outline"
      className={cn(
        'text-xs font-semibold tracking-wider uppercase px-2.5 py-1',
        variants[variant]
      )}
    >
      {label}
    </Badge>
  );
}
