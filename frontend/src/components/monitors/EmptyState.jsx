import { Plus, Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function EmptyState({ onAddMonitor }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-100 text-center">
      <Activity size={32} strokeWidth={1.5} className="text-muted-foreground mb-4" />
      <h2 className="text-xl font-medium text-foreground mb-2">No monitors yet</h2>
      <p className="text-base text-muted-foreground mb-8">
        Add your first monitor to start tracking uptime.
      </p>
      <Button onClick={onAddMonitor}>
        <Plus size={16} strokeWidth={1.5} />
        Add Monitor
      </Button>
    </div>
  );
}
