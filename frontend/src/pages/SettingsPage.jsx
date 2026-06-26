import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useGetSettings, useUpdateSettings } from '@/hooks/useSettings';

export default function SettingsPage() {
  const { settings, isLoading } = useGetSettings();
  const { updateSettings, isPending } = useUpdateSettings();
  const [webhookUrl, setWebhookUrl] = useState('');

  useEffect(() => {
    if (settings) {
      setWebhookUrl(settings.slackWebhookUrl || '');
    }
  }, [settings]);

  const handleSave = async () => {
    await updateSettings({ slackWebhookUrl: webhookUrl });
  };

  if (isLoading) return null;

  return (
    <div className="max-w-xl">
      <h1 className="text-xl font-semibold text-zinc-100 mb-6">Settings</h1>

      <div className="flex flex-col gap-6">
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-zinc-300 mb-4">Notifications</h2>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-zinc-400">Email</label>
              <Input
                value={settings?.email || ''}
                disabled
                className="font-mono text-zinc-500"
              />
              <span className="text-xs text-zinc-600">
                Managed by Clerk. Alert emails are sent to this address.
              </span>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-zinc-400">Slack Webhook URL</label>
              <Input
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://hooks.slack.com/services/..."
                className="font-mono"
              />
              <span className="text-xs text-zinc-600">
                Paste a Slack incoming webhook URL to receive alerts in Slack. Leave empty to disable.
              </span>
            </div>

            <div className="flex justify-end">
              <Button onClick={handleSave} disabled={isPending} size="sm">
                {isPending ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
