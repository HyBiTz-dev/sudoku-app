import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { ServiceWorkerRegistration } from "@/components/pwa/service-worker-registration";
import "./globals.css";

// Google Sans is loaded from Google's CDN with a plain stylesheet link. A
// remote `@import url(...)` in globals.css does not survive the build — the
// bundler strips it — and a `<link>` avoids the serialised @import chain too.
const GOOGLE_SANS_HREF =
  "https://fonts.googleapis.com/css2?family=Google+Sans:ital,opsz,wght,GRAD@0,17..18,400..700,-50..200;1,17..18,400..700,-50..200&display=swap";

const FONT_PRECONNECT = [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" as const },
];

export const metadata: Metadata = {
  title: "Sudoku",
  description: "Generate and play 9x9 sudoku puzzles",
  // `app/manifest.ts` supplies name/icons/display for installability.
  manifest: "/manifest.webmanifest",
  // iOS reads the home screen icon from this link rather than from the manifest.
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  // Standalone launch, without a Safari toolbar and without smart-app-style
  // link rewriting that would hijack in-page anchors.
  appleWebApp: { capable: true, title: "Sudoku", statusBarStyle: "default" },
};

// `themeColor` is deprecated on `metadata` — it belongs here in Next 14+.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f7fc" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1526" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // next-themes sets the `dark` class on <html> before hydration, so the
    // class list deliberately differs from the server render.
    <html lang="en" suppressHydrationWarning>
      <head>
        {FONT_PRECONNECT.map((props) => (
          <link key={props.href} {...props} />
        ))}
        <link rel="stylesheet" href={GOOGLE_SANS_HREF} />
      </head>
      <body className="min-h-full flex flex-col antialiased">
        <ServiceWorkerRegistration />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}