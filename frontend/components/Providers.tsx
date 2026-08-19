"use client";

import { ColorSchemeMode, GuiProvider } from "@sk-web-gui/react";

// GuiProvider injicerar designsystemets tema-CSS-variabler (färger, typografi,
// spacing) som Tailwind-preseten konsumerar. Vi kör ljust färgschema
// (vit/neutral profil).
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <GuiProvider colorScheme={ColorSchemeMode.Light}>{children}</GuiProvider>
  );
}
