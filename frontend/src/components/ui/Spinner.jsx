import { Loader2 } from 'lucide-react';

export default function Spinner() {
  return (
    <div className="flex items-center justify-center min-h-96">
      <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
    </div>
  );
}
