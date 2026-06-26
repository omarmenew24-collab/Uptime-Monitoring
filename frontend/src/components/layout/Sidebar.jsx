import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';

const navItems = [
  { label: 'Dashboard', icon: LayoutDashboard, href: '/dashboard' },
  { label: 'Settings', icon: Settings, href: '/settings' },
];

export default function Sidebar() {
  return (
    <aside className="w-60 h-dvh bg-card border-r border-border flex flex-col shrink-0 sticky top-0">
      <div className="p-6 text-xl font-semibold border-b border-border/50">
        Uptime
      </div>
      <nav className="flex flex-col gap-1 p-4">
        {navItems.map(({ label, icon: Icon, href }) => (
          <NavLink
            key={href}
            to={href}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-md text-base text-muted-foreground',
                'transition-colors hover:bg-secondary hover:text-foreground',
                isActive && 'text-foreground bg-secondary'
              )
            }
          >
            <Icon size={16} strokeWidth={1.5} />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
