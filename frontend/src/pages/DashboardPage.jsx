import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Spinner from '@/components/ui/Spinner';
import { useGetMonitors, useCreateMonitor } from '@/hooks/useMonitors';
import useCreateMonitorForm from '@/hooks/useCreateMonitor';
import MonitorList from '@/components/monitors/MonitorList';
import EmptyState from '@/components/monitors/EmptyState';
import CreateMonitorDialog from '@/components/monitors/CreateMonitorDialog';

export default function DashboardPage() {
  const { monitors, isLoading, isError } = useGetMonitors();
  const { createMyMonitor, isPending } = useCreateMonitor();
  const form = useCreateMonitorForm();

  const handleSubmit = async () => {
    if (!form.validate()) return;
    try {
      await createMyMonitor(form.getSubmitData());
      form.handleOpenChange(false);
    } catch {
      // error handled by useMutation onError toast
    }
  };

  if (isLoading) return <Spinner />;

  if (isError) {
    return (
      <div className="flex items-center justify-center min-h-100 text-muted-foreground">
        Failed to load monitors. Please refresh.
      </div>
    );
  }

  return (
    <>
      {monitors.length === 0 ? (
        <EmptyState onAddMonitor={() => form.setOpen(true)} />
      ) : (
        <div>
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-xl font-semibold text-foreground">Monitors</h1>
            <Button size="sm" onClick={() => form.setOpen(true)}>
              <Plus size={14} strokeWidth={1.5} />
              Add Monitor
            </Button>
          </div>
          <MonitorList monitors={monitors} />
        </div>
      )}

      <CreateMonitorDialog
        open={form.open}
        onOpenChange={form.handleOpenChange}
        formData={form.formData}
        updateField={form.updateField}
        errors={form.errors}
        isSubmitting={isPending}
        onSubmit={handleSubmit}
      />
    </>
  );
}
