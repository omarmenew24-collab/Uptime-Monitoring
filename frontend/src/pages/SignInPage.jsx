import { SignIn } from '@clerk/clerk-react';
import { Activity, Bell, History } from 'lucide-react';

export default function SignInPage() {
  return (
    <div className="grid grid-cols-2 min-h-dvh bg-background max-md:grid-cols-1">
      <div className="flex flex-col justify-center px-16 py-12 border-r border-border max-w-140 ml-auto max-md:hidden">
        <div className="flex items-center gap-3 mb-14">
          <Activity size={28} strokeWidth={1.5} className="text-primary" />
          <span className="text-2xl font-semibold">Uptime</span>
        </div>
        <h1 className="text-3xl font-semibold leading-tight mb-4">
          Know before your users do.
        </h1>
        <p className="text-lg text-muted-foreground mb-14 leading-relaxed">
          Simple, reliable uptime monitoring for developers and small teams.
        </p>
        <ul className="flex flex-col gap-7">
          <li className="flex items-start gap-4 text-base text-muted-foreground">
            <Activity size={20} strokeWidth={1.5} className="text-primary mt-0.5 shrink-0" />
            <span>Monitor any public URL with configurable intervals</span>
          </li>
          <li className="flex items-start gap-4 text-base text-muted-foreground">
            <Bell size={20} strokeWidth={1.5} className="text-primary mt-0.5 shrink-0" />
            <span>Get email alerts the moment your site goes down</span>
          </li>
          <li className="flex items-start gap-4 text-base text-muted-foreground">
            <History size={20} strokeWidth={1.5} className="text-primary mt-0.5 shrink-0" />
            <span>Track full check history and response times</span>
          </li>
        </ul>
      </div>
      <div className="flex items-center justify-center p-8 max-md:min-h-dvh">
        <SignIn
          path="/sign-in"
          routing="path"
          signUpUrl="/sign-up"
          fallbackRedirectUrl="/dashboard"
        />
      </div>
    </div>
  );
}
