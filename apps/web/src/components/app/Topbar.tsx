"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/Button";

export function Topbar({ organizationName }: { organizationName: string }) {
  const router = useRouter();

  async function onLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6">
      <span className="text-sm text-slate-500">{organizationName}</span>
      <Button variant="ghost" size="sm" onClick={onLogout}>
        <LogOut className="h-4 w-4" aria-hidden="true" />
        Log out
      </Button>
    </header>
  );
}
