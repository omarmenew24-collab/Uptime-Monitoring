import { UserButton } from '@clerk/clerk-react';

export default function TopBar({ title = 'Dashboard' }) {
  return (
    <header className="h-14 bg-background border-b border-border/50 flex items-center justify-between px-8 sticky top-0 z-10">
      <span className="text-base font-medium text-foreground">{title}</span>
      <UserButton afterSignOutUrl="/sign-in" />
    </header>
  );
}
