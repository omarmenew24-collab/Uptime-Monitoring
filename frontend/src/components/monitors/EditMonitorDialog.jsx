import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useEditMonitor } from '@/hooks/useMonitors';

export default function EditMonitorDialog({ monitor, open, onOpenChange }) {
  const { editMonitor, isPending } = useEditMonitor();
  const [formData, setFormData] = useState({
    name: '',
    url: '',
    intervalMinutes: 5,
    failureThreshold: 2,
  });
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (monitor && open) {
      setFormData({
        name: monitor.name,
        url: monitor.url,
        intervalMinutes: monitor.interval_minutes,
        failureThreshold: monitor.failure_threshold,
      });
      setErrors({});
    }
  }, [monitor, open]);

  const updateField = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: null }));
  };

  const validate = () => {
    const newErrors = {};
    if (!formData.name.trim()) newErrors.name = 'Name is required';
    if (!formData.url.trim()) {
      newErrors.url = 'URL is required';
    } else if (!formData.url.startsWith('http://') && !formData.url.startsWith('https://')) {
      newErrors.url = 'URL must start with http:// or https://';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    try {
      await editMonitor({
        monitorId: monitor.id,
        data: {
          name: formData.name.trim(),
          url: formData.url.trim(),
          interval_minutes: formData.intervalMinutes,
          failure_threshold: formData.failureThreshold,
        },
      });
      onOpenChange(false);
    } catch {
      // handled by mutation onError
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg">Edit Monitor</DialogTitle>
          <DialogDescription>Update monitor configuration.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 py-4">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-foreground">Name</label>
            <Input
              placeholder="Marketing Site"
              value={formData.name}
              onChange={(e) => updateField('name', e.target.value)}
            />
            {errors.name && (
              <span className="text-sm text-destructive">{errors.name}</span>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-foreground">URL</label>
            <Input
              className="font-mono"
              placeholder="https://example.com"
              value={formData.url}
              onChange={(e) => updateField('url', e.target.value)}
            />
            {errors.url && (
              <span className="text-sm text-destructive">{errors.url}</span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-foreground">Check every</label>
              <Select
                value={String(formData.intervalMinutes)}
                onValueChange={(val) => updateField('intervalMinutes', Number(val))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 minute</SelectItem>
                  <SelectItem value="5">5 minutes</SelectItem>
                  <SelectItem value="10">10 minutes</SelectItem>
                  <SelectItem value="30">30 minutes</SelectItem>
                  <SelectItem value="60">60 minutes</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-foreground">Alert after</label>
              <Select
                value={String(formData.failureThreshold)}
                onValueChange={(val) => updateField('failureThreshold', Number(val))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 failure</SelectItem>
                  <SelectItem value="2">2 failures</SelectItem>
                  <SelectItem value="3">3 failures</SelectItem>
                  <SelectItem value="5">5 failures</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending ? 'Saving...' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
