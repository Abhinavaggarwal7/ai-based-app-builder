"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Show, SignInButton, UserButton } from "@clerk/nextjs";
import { ArrowRight, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PricingModal } from "@/components/PricingModal";

const CREDITS_UPDATED_EVENT = "forge:credits-updated";

export default function HeaderClient({
  initialCredits,
}: {
  initialCredits: number | null;
}) {
  const [credits, setCredits] = useState(initialCredits);

  useEffect(() => {
    const handleCreditsUpdated = (event: Event) => {
      const updatedCredits = (event as CustomEvent<{ credits?: number }>).detail
        ?.credits;
      if (typeof updatedCredits === "number" && Number.isFinite(updatedCredits)) {
        setCredits(updatedCredits);
      }
    };

    window.addEventListener(CREDITS_UPDATED_EVENT, handleCreditsUpdated);
    return () =>
      window.removeEventListener(CREDITS_UPDATED_EVENT, handleCreditsUpdated);
  }, []);

  return (
    <header className="fixed top-0 left-0 right-0 z-50 h-16 border-b border-white/6 bg-white/7 backdrop-blur-md">
      <nav className="mx-auto flex h-full max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 select-none">
          <Image
            src="/logo.png"
            alt="Forge"
            width={100}
            height={100}
            className="h-9 w-auto rounded-md"
          />
        </Link>

        <div className="flex items-center gap-5">
          <Show when="signed-in">
            <Link
              href="/projects"
              className="text-[13px] font-medium text-white/40 transition-colors hover:text-white/80"
            >
              Projects
            </Link>

            {credits !== null && (
              <PricingModal>
                <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 text-xs text-white/70">
                  <Zap className="h-3 w-3 fill-white/70" />
                  {credits} credits
                </span>
              </PricingModal>
            )}

            <UserButton />
          </Show>

          <Show when="signed-out">
            <SignInButton mode="modal">
              <Button
                variant="ghost"
                size="sm"
                className="text-[13px] font-medium text-white/50 hover:bg-transparent hover:text-white/90"
              >
                Sign in
              </Button>
            </SignInButton>

            <SignInButton mode="modal">
              <Button
                size="sm"
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white px-4 text-[13px] font-semibold text-black hover:bg-white/90 active:scale-95"
              >
                Get Started
                <ArrowRight className="h-3 w-3 opacity-60" />
              </Button>
            </SignInButton>
          </Show>
        </div>
      </nav>
    </header>
  );
}
